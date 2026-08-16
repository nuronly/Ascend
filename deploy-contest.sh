#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════
#  阶梯 · 比赛服务器一键部署（单体模式，无 Nginx）
#
#  与 install.sh 的分工：
#    install.sh        面向正式服务器：Nginx 反代 :80/:443 + systemd
#    deploy-contest.sh 面向比赛 ECS：平台禁用 80/443/8080/8443，
#                      uvicorn 直接监听 8848 并托管前端静态文件
#                      （单体），一个进程搞定，也绕开了反代的
#                      SSE 缓冲坑（那本来就是 Nginx 特有的问题）。
#
#  用法（服务器上，root）：
#      git clone https://github.com/nuronly/Ascend.git /opt/ladder
#      cd /opt/ladder && ./deploy-contest.sh
#
#  首次运行会生成 backend/.env 并停下等你填 LLM key，
#  填完再执行一次即可。换端口：PORT=9000 ./deploy-contest.sh
#  重复执行 = 更新部署（保留数据与配置）。
# ═════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
PORT="${PORT:-8848}"

B=$'\033[1m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; D=$'\033[2m'; X=$'\033[0m'
ok()   { printf "${G}✓${X} %s\n" "$1"; }
warn() { printf "${Y}!${X} %s\n" "$1"; }
die()  { printf "${R}✗${X} %s\n" "$1"; exit 1; }
step() { printf "\n${B}%s${X}\n" "$1"; }
info() { printf "  ${D}%s${X}\n" "$1"; }

[ "$(id -u)" = "0" ] || die "请用 root 运行：sudo ./deploy-contest.sh"

# ── 1. 识别系统 ──────────────────────────────────────────────
step "1/7  识别系统"
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
step "2/7  uv 与后端依赖"
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

# ── 3. Node + 前端构建 ───────────────────────────────────────
step "3/7  前端构建"
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
if [ ! -d node_modules ]; then
  info "安装前端依赖…"
  npm ci --no-audit --no-fund --silent || npm install --no-audit --no-fund --silent || die "npm 安装失败"
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
step "4/7  配置"
ENVF="$ROOT/backend/.env"
if [ ! -f "$ENVF" ]; then
  cp "$ROOT/.env.prod.example" "$ENVF"
  SECRET=$(openssl rand -base64 48 2>/dev/null | tr -d '\n' || head -c 48 /dev/urandom | base64 | tr -d '\n')
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${SECRET}|" "$ENVF"
  ok "已生成 backend/.env 并自动填入随机 JWT_SECRET"

  printf "\n${B}请填写 LLM 配置${X}\n"
  info "必填：DEEPSEEK_API_KEY、MAAS_API_KEY、MAAS_BASE_URL"
  printf "  编辑：${B}vi %s${X}\n" "$ENVF"
  printf "  填完再执行一次：${B}./deploy-contest.sh${X}\n\n"
  exit 0
fi

# 单体模式 + 非 HTTPS 的关键配置，每次部署都强制对齐
sed -i "s|^APP_ENV=.*|APP_ENV=prod|" "$ENVF"
sed -i "s|^SERVE_FRONTEND=.*|SERVE_FRONTEND=true|" "$ENVF" 2>/dev/null || true
grep -q '^SERVE_FRONTEND=' "$ENVF" || echo "SERVE_FRONTEND=true" >> "$ENVF"
grep -q '^FRONTEND_DIST=' "$ENVF" || echo "FRONTEND_DIST=${ROOT}/frontend/dist" >> "$ENVF"
grep -q '^RATE_LIMIT_ENABLED=' "$ENVF" || echo "RATE_LIMIT_ENABLED=true" >> "$ENVF"
sed -i "s|^DATABASE_URL=.*|DATABASE_URL=sqlite+aiosqlite:///${ROOT}/backend/data/ladder.db|" "$ENVF"
# ★ HTTP 下浏览器不回传 Secure cookie —— 不关的话登录成功立刻退回登录页
sed -i "s|^COOKIE_SECURE=.*|COOKIE_SECURE=false|" "$ENVF"

set -a; . "$ENVF"; set +a
[ -n "${JWT_SECRET:-}" ] && [ ${#JWT_SECRET} -ge 32 ] || die "JWT_SECRET 未设置或过短"
[ -n "${DEEPSEEK_API_KEY:-}${MAAS_API_KEY:-}" ] || die "未配置任何 LLM API key（vi $ENVF）"
ok "配置就绪（单体模式 · HTTP · 端口 ${PORT}）"

mkdir -p "$ROOT/backend/data" "$ROOT/backend/logs"

# ── 5. systemd ───────────────────────────────────────────────
step "5/7  注册系统服务"
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
# 单 worker：SQLite 多进程写会锁竞争。
ExecStart=${ROOT}/backend/.venv/bin/uvicorn app.main:app \
    --host 0.0.0.0 --port ${PORT} \
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
sleep 5

if systemctl is-active --quiet ladder; then
  ok "服务已启动"
else
  printf "${R}✗${X} 服务启动失败，最近日志：\n"
  tail -30 "$ROOT/backend/logs/server.log" 2>/dev/null || journalctl -u ladder -n 30 --no-pager
  exit 1
fi

# ── 6. 日志轮转 ──────────────────────────────────────────────
# server.log 是纯 append，长跑会无限长大；磁盘满 → SQLite 写不进 → 服务挂。
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
  ok "日志轮转已配置"
fi

# ── 7. 自检 ──────────────────────────────────────────────────
step "7/7  自检"
BODY=$(curl -fsS -m 10 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || echo '')
case "$BODY" in
  *'"status":"ok"'*) ok "API 正常  $BODY" ;;
  *) die "健康检查失败，查日志：tail -30 $ROOT/backend/logs/server.log" ;;
esac

HOME_CODE=$(curl -s -m 5 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/" || echo '000')
[ "$HOME_CODE" = "200" ] && ok "前端首页 200" || warn "首页返回 $HOME_CODE（前端 dist 可能未构建）"
SPA_CODE=$(curl -s -m 5 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/vault" || echo '000')
[ "$SPA_CODE" = "200" ] && ok "SPA 深层路由 200" || warn "SPA fallback 返回 $SPA_CODE"

printf "\n${B}部署完成${X}\n\n"
printf "  访问地址  ${B}http://203.205.91.43:%s${X}\n" "$PORT"
warn "打不开的话，99% 是比赛平台的安全组没放行 ${PORT} 端口"
cat <<TIP

  常用命令
    systemctl status ladder          查看状态
    systemctl restart ladder         重启
    tail -f ${ROOT}/backend/logs/server.log    实时日志
    cd ${ROOT} && git pull && ./deploy-contest.sh   更新部署

TIP
