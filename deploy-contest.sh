#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════
#  阶梯 · 比赛服务器一键部署（单体模式，无 Nginx）
#
#  三条部署路线的分工（互斥，一台机器只能选一条）：
#    install.sh        正式服务器：Nginx 反代 :80/:443 + systemd
#    deploy.sh         Docker + Caddy（自动 HTTPS）
#    deploy-contest.sh 比赛 ECS：平台只放行少数端口，uvicorn 直接监听
#                      并同时托管前端静态文件（单体），一个进程搞定，
#                      也绕开了反代的 SSE 缓冲坑 —— 那本来就是 Nginx
#                      特有的问题。
#
#  ⚠️ 这台机器上不要执行 ./update.sh 之外的其它部署脚本，也不要手动
#     跑 install.sh：三者抢同一个 systemd 单元，混用会让站点失联。
#     脚本会在开头自动核对，冲突时直接拒绝执行。
#
#  用法（服务器上，root）：
#      git clone https://github.com/nuronly/Ascend.git /opt/ladder
#      cd /opt/ladder && ./deploy-contest.sh
#
#  首次运行会生成 backend/.env 并停下等你填 LLM key，填完再执行一次即可。
#  换端口：PORT=9000 ./deploy-contest.sh
#  重复执行 = 更新部署（保留数据与配置，重启前自动备份数据库）。
# ═════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
LADDER_ROOT="$ROOT"
# shellcheck source=deploy-lib.sh
. "$ROOT/deploy-lib.sh"

# 端口：SynNovator 平台默认只放行 22，官方后来开放了 8000（见比赛通知）。
# 8000 是当前唯一适合 Web 服务的端口（22 被 SSH 占用、3389 是 Windows RDP）。
# 没显式指定时，沿用单元文件里已经在跑的端口 —— 免得一次例行更新
# 把在线站点换到另一个没放行的端口上。
PORT="${PORT:-}"
[ -n "$PORT" ] || PORT="$(ladder_service_port 2>/dev/null || true)"
PORT="${PORT:-8000}"

B=$'\033[1m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; D=$'\033[2m'; X=$'\033[0m'
ok()   { printf "${G}✓${X} %s\n" "$1"; }
warn() { printf "${Y}!${X} %s\n" "$1"; }
die()  { printf "${R}✗${X} %s\n" "$1"; exit 1; }
step() { printf "\n${B}%s${X}\n" "$1"; }
info() { printf "  ${D}%s${X}\n" "$1"; }

[ "$(id -u)" = "0" ] || die "请用 root 运行：sudo ./deploy-contest.sh"

# 这台机器是不是已经被另一条路线部署过了 —— 冲突就在这里拦住
ladder_mode_assert contest

# ── 1. 识别系统 ──────────────────────────────────────────────
step "1/8  识别系统"
if command -v apt-get >/dev/null 2>&1; then
  PKG=apt; INSTALL="apt-get install -y -qq"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
elif command -v dnf >/dev/null 2>&1; then
  PKG=dnf; INSTALL="dnf install -y -q"
elif command -v yum >/dev/null 2>&1; then
  PKG=yum; INSTALL="yum install -y -q"
else
  die "无法识别包管理器（支持 apt / dnf / yum）"
fi
. /etc/os-release 2>/dev/null || true
ok "${PRETTY_NAME:-未知系统}"

MEM=$(free -m | awk '/^Mem:/{print $2}')
info "内存 ${MEM}MB"
# 小内存机器先加 swap，否则前端构建必被 OOM 杀掉
if [ "$MEM" -lt 1800 ]; then
  if ! swapon --show 2>/dev/null | grep -q .; then
    warn "内存偏小，创建 2G swap 以免构建时 OOM"
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
    grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    ok "swap 已启用"
  fi
fi

# ── 2. uv + Python ───────────────────────────────────────────
step "2/8  uv 与后端依赖"
export PATH="$HOME/.local/bin:/root/.local/bin:$PATH"
if ! command -v uv >/dev/null 2>&1; then
  info "安装 uv…"
  curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1 \
    || die "uv 安装失败（网络问题可重试）"
  export PATH="$HOME/.local/bin:$PATH"
fi
ok "uv $(uv --version | grep -oE '[0-9.]+' | head -1)"

cd "$ROOT/backend"
info "同步 Python 依赖（uv 会自动装好 Python 3.12）…"
uv sync --quiet || die "uv sync 失败"
ok "后端依赖就绪"
cd "$ROOT"

# ── 3. Node + 前端构建 ───────────────────────────────────────
step "3/8  前端构建"
NODE_VER="v22.14.0"  # 带 v 前缀：npmmirror 的文件名是 node-v22.14.0-linux-x64.tar.xz
node_ok() { command -v node >/dev/null 2>&1 && node -e 'process.exit(parseInt(process.version.slice(1))>=18?0:1)' 2>/dev/null; }
if ! node_ok; then
  info "安装 Node ${NODE_VER}（npmmirror）…"
  ARCH=$(uname -m); case "$ARCH" in x86_64) NARCH=x64 ;; aarch64) NARCH=arm64 ;; *) die "不支持的架构 $ARCH" ;; esac
  curl -fsSL "https://cdn.npmmirror.com/binaries/node/${NODE_VER}/node-${NODE_VER}-linux-${NARCH}.tar.xz" -o /tmp/node.tar.xz \
    || curl -fsSL "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-${NARCH}.tar.xz" -o /tmp/node.tar.xz \
    || die "Node 下载失败"
  mkdir -p /usr/local/lib/nodejs && tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs
  NODE_HOME="/usr/local/lib/nodejs/node-${NODE_VER}-linux-${NARCH}/bin"
  ln -sf "$NODE_HOME/node" /usr/local/bin/node
  ln -sf "$NODE_HOME/npm" /usr/local/bin/npm
  ln -sf "$NODE_HOME/npx" /usr/local/bin/npx 2>/dev/null || true
  rm -f /tmp/node.tar.xz
  export PATH="$NODE_HOME:$PATH"
  hash -r 2>/dev/null || true
fi
node_ok || die "Node 装完仍不可用（which -a node 排查 PATH 抢占）"
ok "Node $(node -v)"

cd "$ROOT/frontend"
npm config set registry https://registry.npmmirror.com >/dev/null 2>&1

# ★ 不能只判断 node_modules 是否存在。git pull 带来新依赖时，目录明明在，
#   但里面缺了新包 —— 构建要么报找不到模块，要么用旧版本"构建成功"而行为
#   不对。按 package-lock.json 的哈希判断，变了就重装，没变就跳过（省几分钟）。
lock_hash() { { md5sum "$1" 2>/dev/null || shasum "$1" 2>/dev/null || echo none; } | awk '{print $1}'; }
DEPS_STAMP="node_modules/.ladder-deps-hash"
WANT_HASH=$(lock_hash package-lock.json)
if [ ! -d node_modules ] || [ "$(cat "$DEPS_STAMP" 2>/dev/null || true)" != "$WANT_HASH" ]; then
  info "安装前端依赖（依赖清单有变化）…"
  npm ci --no-audit --no-fund --silent || npm install --no-audit --no-fund --silent || die "npm 安装失败"
  printf '%s\n' "$WANT_HASH" > "$DEPS_STAMP"
else
  ok "前端依赖已是最新，跳过安装"
fi

info "构建前端（约 1~3 分钟）…"
BUILD_LOG=/tmp/ladder-build.log
if ! NODE_OPTIONS="--max-old-space-size=1536" npm run build >"$BUILD_LOG" 2>&1; then
  tail -25 "$BUILD_LOG"
  die "前端构建失败，完整日志见 $BUILD_LOG（内存不足可在本地构建后上传 dist）"
fi
ok "前端构建完成"
cd "$ROOT"

# ── 4. 配置 ──────────────────────────────────────────────────
step "4/8  配置"
ENVF="$ROOT/backend/.env"
if [ ! -f "$ENVF" ]; then
  cp "$ROOT/.env.prod.example" "$ENVF"
  SECRET=$(openssl rand -base64 48 2>/dev/null | tr -d '\n' || head -c 48 /dev/urandom | base64 | tr -d '\n')
  ladder_env_set "$ENVF" JWT_SECRET "$SECRET"
  ok "已生成 backend/.env 并自动填入随机 JWT_SECRET"

  printf "\n${B}请填写 LLM 配置${X}\n"
  info "必填：DEEPSEEK_API_KEY、MAAS_API_KEY、MAAS_BASE_URL"
  printf "  编辑：${B}vi %s${X}\n" "$ENVF"
  printf "  填完再执行一次：${B}./deploy-contest.sh${X}\n\n"
  exit 0
fi

# 单体模式的关键配置，每次部署都强制对齐（实现在 deploy-lib.sh，update.sh
# 的快路径也会调同一个函数，保证只重启后端时这些项同样是对的）：
#   ★ COOKIE_SECURE=false     —— HTTP 下浏览器不回传 Secure cookie，
#                                 不关的话登录成功会立刻退回登录页
#   ★★ TRUST_PROXY_HEADERS=false —— 没有反代，X-Forwarded-For 完全由客户端
#                                 控制；仍然信任它就等于让人自选来源 IP，
#                                 换个 header 换个限流桶，防护全部作废
ladder_apply_mode_env contest "$ENVF" "$ROOT"
ladder_env_set "$ENVF" DATABASE_URL "sqlite+aiosqlite:///${ROOT}/backend/data/ladder.db"
# .env 里是密钥，别留成全局可读（cp 自 example 时是 644）
chmod 600 "$ENVF"

set -a; . "$ENVF"; set +a
[ -n "${JWT_SECRET:-}" ] && [ ${#JWT_SECRET} -ge 32 ] || die "JWT_SECRET 未设置或过短"
[ -n "${DEEPSEEK_API_KEY:-}${MAAS_API_KEY:-}" ] || die "未配置任何 LLM API key（vi $ENVF）"
ok "配置就绪（单体模式 · HTTP · 端口 ${PORT}）"
info "限流按连接来源 IP 计算（已关闭对 X-Forwarded-For 的信任）"

mkdir -p "$ROOT/backend/data" "$ROOT/backend/logs"

# ── 5. 备份数据库 ────────────────────────────────────────────
# 这是有真实用户数据的机器，重新部署要留一个回退点：本次更新可能带了
# schema 变更，出了问题总得回得去。
step "5/8  备份数据库"
if ladder_backup_db; then
  ok "已备份到 backend/data/backups/（自动保留最近 30 份）"
else
  case $? in
    2) info "还没有数据库，跳过（首次部署）" ;;
    *) warn "备份失败，继续部署 —— 如果在意数据，先 Ctrl+C 手工备份" ;;
  esac
fi

# ── 6. systemd ───────────────────────────────────────────────
step "6/8  注册系统服务"
cat > /etc/systemd/system/ladder.service <<EOF
[Unit]
Description=Ladder · 以疑问为原子单位的学习工作台（比赛单体部署）
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
WorkingDirectory=${ROOT}/backend
Environment="PATH=${ROOT}/backend/.venv/bin:/usr/local/bin:/usr/bin:/bin"
Environment="TZ=Asia/Shanghai"
# 单体模式：uvicorn 直接对外，同时提供 API 与前端静态文件。
# 刻意不加 --proxy-headers：没有反代，转发头都是客户端伪造的，认了就等于
# 让任何人自选来源 IP（限流按 IP 算）。
# 单 worker：SQLite 多进程写会锁竞争。
ExecStart=${ROOT}/backend/.venv/bin/uvicorn app.main:app \\
    --host 0.0.0.0 --port ${PORT} \\
    --timeout-keep-alive 75
Restart=always
RestartSec=3
StandardOutput=append:${ROOT}/backend/logs/server.log
StandardError=append:${ROOT}/backend/logs/server.log
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ladder >/dev/null 2>&1
systemctl restart ladder
# 记下部署方式：下次跑别的脚本时会被拦住，update.sh 也靠它选择更新路径
ladder_mode_write contest
sleep 5

if systemctl is-active --quiet ladder; then
  ok "服务已启动"
else
  printf "${R}✗${X} 服务启动失败，最近日志：\n"
  tail -30 "$ROOT/backend/logs/server.log" 2>/dev/null || journalctl -u ladder -n 30 --no-pager
  exit 1
fi

# ── 7. 日志轮转与端口 ────────────────────────────────────────
# server.log 是纯 append，长跑会无限长大；磁盘满 → SQLite 写不进 → 服务挂。
step "7/8  日志轮转与端口"
command -v logrotate >/dev/null 2>&1 || $INSTALL logrotate >/dev/null 2>&1 || true
if command -v logrotate >/dev/null 2>&1; then
  cat > /etc/logrotate.d/ladder <<EOF
${ROOT}/backend/logs/*.log {
    daily
    rotate 14
    maxsize 200M
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
EOF
  ok "日志轮转已配置（每日或超 200M，留 14 份）"
else
  warn "logrotate 装不上，日志会无限增长。应急截断：> $ROOT/backend/logs/server.log"
fi

# 本机防火墙常常拦着，症状和安全组没放行一模一样：本机 curl 通、外面不通
ladder_open_port "$PORT"
ok "本机防火墙已放行 ${PORT}（若原本就没开防火墙则无操作）"

# ── 8. 自检 ──────────────────────────────────────────────────
step "8/8  自检"
BODY=$(curl -fsS -m 10 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || echo '')
case "$BODY" in
  *'"status":"ok"'*) ok "API 正常  $BODY" ;;
  *) die "健康检查失败，查日志：tail -30 $ROOT/backend/logs/server.log" ;;
esac

HOME_CODE=$(curl -s -m 5 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/" || echo '000')
[ "$HOME_CODE" = "200" ] && ok "前端首页 200" || warn "首页返回 $HOME_CODE（前端 dist 可能未构建）"
SPA_CODE=$(curl -s -m 5 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/vault" || echo '000')
[ "$SPA_CODE" = "200" ] && ok "SPA 深层路由 200" || warn "SPA fallback 返回 $SPA_CODE"

# 配置层面的上线自检（额度、准入、限流、数据文件…）
"$ROOT/backend/.venv/bin/python" "$ROOT/backend/scripts/preflight.py" 2>/dev/null \
  || warn "自检脚本执行异常（不影响服务运行）"

# ── 完成 ─────────────────────────────────────────────────────
IP=$(ladder_public_ip || true)
printf "\n${B}部署完成${X}\n\n"
if [ -n "${IP:-}" ]; then
  printf "  访问地址  ${B}http://%s:%s${X}\n" "$IP" "$PORT"
else
  printf "  访问地址  ${B}http://<服务器公网IP>:%s${X}\n" "$PORT"
  warn "未能自动探测公网 IP —— 到比赛平台的实例详情页查看"
  info "注意区分：10.x / 172.16~31.x / 192.168.x 都是内网地址，外部访问不了"
fi
warn "打不开的话，99% 是比赛平台的安全组没放行 ${PORT} 端口"
cat <<TIP

  常用命令
    systemctl status ladder                          查看状态
    systemctl restart ladder                         重启
    tail -f ${ROOT}/backend/logs/server.log    实时日志
    cd ${ROOT} && ./update.sh                  更新（会自动认出是单体模式）

  ⚠️ 不要在这台机器上执行 install.sh 或 deploy.sh —— 它们是另外两条
     互斥的部署路线，会抢同一个 systemd 单元。脚本已加互检，会拒绝执行。

  注册第一个账号后，建议编辑 backend/.env 把 ALLOW_REGISTRATION 改为 false
  （或设 INVITE_CODE），然后 systemctl restart ladder，
  避免陌生人注册后消耗你的 API 额度。

TIP
