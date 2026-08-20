#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════
#  阶梯 · 服务器一键部署
#
#  在服务器上执行：
#      git clone https://github.com/nuronly/Ascend.git ladder
#      cd ladder
#      ./deploy.sh
#
#  脚本会：检查环境 → 引导填配置 → 构建 → 启动 → 自检
#  重复执行 = 更新部署（会保留数据）
# ═════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
LADDER_ROOT="$ROOT"
# shellcheck source=deploy-lib.sh
. "$ROOT/deploy-lib.sh"

B=$'\033[1m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; D=$'\033[2m'; X=$'\033[0m'
say()  { printf "%s\n" "$1"; }
ok()   { printf "${G}✓${X} %s\n" "$1"; }
warn() { printf "${Y}!${X} %s\n" "$1"; }
die()  { printf "${R}✗${X} %s\n" "$1"; exit 1; }
step() { printf "\n${B}%s${X}\n" "$1"; }

# ── 1. 环境检查 ───────────────────────────────────────────────
step "1/6  检查环境"

if ! command -v docker >/dev/null 2>&1; then
  die "未安装 Docker。执行：curl -fsSL https://get.docker.com | sh"
fi
ok "Docker $(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  die "未安装 Docker Compose 插件。执行：apt-get install -y docker-compose-plugin"
fi
ok "Compose 就绪"

if ! docker info >/dev/null 2>&1; then
  die "Docker 守护进程未运行或当前用户无权限。试：sudo systemctl start docker，或把用户加入 docker 组"
fi

# 这台机器是不是已经被裸机路线部署过了 —— 那边的 Nginx 正占着 80，
# 直接起 Caddy 只会撞端口，而报错信息完全指不到根因
ladder_mode_assert docker

MEM=$(free -m 2>/dev/null | awk '/^Mem:/{print $2}' || echo 0)
if [ "$MEM" -gt 0 ] && [ "$MEM" -lt 1800 ]; then
  warn "内存仅 ${MEM}MB —— 前端构建阶段可能 OOM。稍后若失败，见文末「内存不足」处理"
fi

# ── 2. 配置 ──────────────────────────────────────────────────
step "2/6  配置"

if [ ! -f .env.prod ]; then
  cp .env.prod.example .env.prod
  say "已生成 .env.prod"

  # 自动填一个强随机密钥，省得用户忘记
  SECRET=$(openssl rand -base64 48 2>/dev/null | tr -d '\n' || head -c 48 /dev/urandom | base64 | tr -d '\n')
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${SECRET}|" .env.prod
  ok "已自动生成 JWT_SECRET"

  printf "\n${B}接下来请填写 .env.prod${X}\n"
  say "${D}必填三项：${X}"
  say "  SITE_ADDRESS   有备案域名填域名（自动 HTTPS）；只有 IP 就填 :80"
  say "  DEEPSEEK_API_KEY"
  say "  MAAS_API_KEY   （embedding 和生图要用，DeepSeek 官方没有这两项）"
  say ""
  say "编辑：${B}vi .env.prod${X}   填完再执行一次 ./deploy.sh"
  exit 0
fi

# 载入配置做校验
set -a; . ./.env.prod; set +a

[ -n "${JWT_SECRET:-}" ] || die ".env.prod 里 JWT_SECRET 为空"
[ "${#JWT_SECRET}" -ge 32 ] || die "JWT_SECRET 太短（当前 ${#JWT_SECRET} 字符，需 ≥32）"
[ -n "${DEEPSEEK_API_KEY:-}${MAAS_API_KEY:-}" ] || die ".env.prod 里没有配置任何 LLM API key"
ok "密钥已配置"

SITE_ADDRESS="${SITE_ADDRESS:-:80}"
if [ "$SITE_ADDRESS" = ":80" ]; then
  warn "使用 IP + HTTP 模式（无域名）"
  say "  ${D}HTTP 下浏览器不接受 Secure cookie，脚本会自动设 COOKIE_SECURE=false${X}"
  say "  ${D}这只适合临时演示；正式对外请用备案域名，几分钟就能换过来${X}"
  # HTTP 下必须关掉 Secure，否则登录态存不住 —— 表现为「登录成功但立刻退回登录页」
  if grep -q "^COOKIE_SECURE=" .env.prod; then
    sed -i "s|^COOKIE_SECURE=.*|COOKIE_SECURE=false|" .env.prod
  else
    echo "COOKIE_SECURE=false" >> .env.prod
  fi
else
  ok "域名模式：$SITE_ADDRESS（Caddy 会自动申请 HTTPS 证书）"
  sed -i "s|^COOKIE_SECURE=.*|COOKIE_SECURE=true|" .env.prod 2>/dev/null || true
  # CORS 与公开地址跟着域名走
  sed -i "s|^CORS_ORIGINS=.*|CORS_ORIGINS=https://${SITE_ADDRESS}|" .env.prod 2>/dev/null || true
  sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=https://${SITE_ADDRESS}|" .env.prod 2>/dev/null || true
fi

# ── 3. 端口占用 ──────────────────────────────────────────────
step "3/6  检查端口"
for P in 80 443; do
  if command -v ss >/dev/null 2>&1 && ss -lntp 2>/dev/null | grep -q ":${P} "; then
    OCC=$(ss -lntp 2>/dev/null | grep ":${P} " | head -1)
    warn "端口 ${P} 已被占用：${OCC}"
    say "  ${D}若是 nginx/apache，先停掉：systemctl stop nginx${X}"
  else
    ok "端口 ${P} 可用"
  fi
done

# ── 4. 构建 ──────────────────────────────────────────────────
step "4/6  构建镜像"
say "${D}首次构建约 3~8 分钟（装依赖 + 前端打包），之后有缓存会快很多${X}"
$DC build || die "构建失败。若卡在拉取镜像，配置 Docker 镜像加速后重试（见 README）"
ok "构建完成"

# ── 5. 启动 ──────────────────────────────────────────────────
step "5/6  启动服务"
$DC up -d
# 记下部署方式：另外两个脚本会据此拒绝覆盖，update.sh 也靠它选择更新路径
ladder_mode_write docker
say "${D}等待健康检查…${X}"

HEALTHY=0
for i in $(seq 1 40); do
  if curl -fsS -m 3 http://127.0.0.1/api/health >/dev/null 2>&1; then HEALTHY=1; break; fi
  # 容器内部先探一次，区分「应用没起来」还是「Caddy 没转发」
  # 用 $DC 而不是写死 docker compose：只有 v1（docker-compose）的机器上，
  # 写死会静默失败，于是永远探测不到"应用其实是好的"这个事实
  if $DC exec -T app curl -fsS -m 3 http://127.0.0.1:8788/api/health >/dev/null 2>&1; then
    HEALTHY=2
  fi
  sleep 3
done

if [ "$HEALTHY" = "1" ]; then
  ok "服务已就绪"
elif [ "$HEALTHY" = "2" ]; then
  warn "应用正常，但通过 80 端口访问不到 —— 多半是 Caddy 或安全组问题"
  $DC logs --tail 20 caddy
else
  printf "${R}✗${X} 启动失败，最近日志：\n"
  $DC logs --tail 40 app
  exit 1
fi

# ── 6. 自检 ──────────────────────────────────────────────────
step "6/6  自检"
$DC exec -T app python scripts/preflight.py 2>/dev/null || warn "自检脚本执行异常（不影响服务运行）"

# ── 完成 ─────────────────────────────────────────────────────
IP=$(ladder_public_ip || echo "<服务器公网IP>")
printf "\n${B}部署完成${X}\n\n"
if [ "$SITE_ADDRESS" = ":80" ]; then
  say "  访问地址   ${B}http://${IP}${X}"
  say ""
  warn "如果打不开，99% 是${B}阿里云安全组没放行 80 端口${X}"
  say "  ${D}控制台 → ECS 实例 → 安全组 → 配置规则 → 入方向 → 手动添加${X}"
  say "  ${D}端口 80/80，授权对象 0.0.0.0/0${X}"
else
  say "  访问地址   ${B}https://${SITE_ADDRESS}${X}"
  say "  ${D}首次访问会等几秒 —— Caddy 正在申请证书${X}"
  say ""
  warn "确认：域名已解析到本机 IP，且安全组放行了 80 和 443"
  say "  ${D}80 端口是证书校验必需的，只开 443 会申请失败${X}"
fi
say ""
say "  常用命令"
say "    $DC logs -f app        ${D}看实时日志${X}"
say "    $DC restart app        ${D}重启应用${X}"
say "    $DC down               ${D}停止（数据保留在卷里）${X}"
say "    ./deploy.sh            ${D}更新代码后重新部署${X}"
say ""
say "  ${D}注册第一个账号后，建议把 .env.prod 里的 ALLOW_REGISTRATION 改成 false，${X}"
say "  ${D}然后 $DC up -d —— 避免陌生人消耗你的 API 额度。${X}"
say ""
