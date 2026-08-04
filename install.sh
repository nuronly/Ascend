#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════
#  阶梯 · 裸机部署（不用 Docker）
#
#  架构：Nginx(:80) → uvicorn(:8788, 由 systemd 托管，同时提供前端静态文件)
#
#  用法（在服务器上，root 或 sudo）：
#      git clone https://github.com/nuronly/Ascend.git /opt/ladder
#      cd /opt/ladder && ./install.sh
#
#  重复执行 = 更新部署（保留数据与配置）
#  跳过前端构建（内存不足时，用本地传上来的 dist）：
#      ./install.sh --skip-build
# ═════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

B=$'\033[1m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; D=$'\033[2m'; X=$'\033[0m'
ok()   { printf "${G}✓${X} %s\n" "$1"; }
warn() { printf "${Y}!${X} %s\n" "$1"; }
die()  { printf "${R}✗${X} %s\n" "$1"; exit 1; }
step() { printf "\n${B}%s${X}\n" "$1"; }
info() { printf "  ${D}%s${X}\n" "$1"; }

SKIP_BUILD=0
[[ "${1:-}" == "--skip-build" ]] && SKIP_BUILD=1

[ "$(id -u)" = "0" ] || die "请用 root 运行：sudo ./install.sh"

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
ok "${PRETTY_NAME:-未知系统}  包管理器：$PKG"

MEM=$(free -m | awk '/^Mem:/{print $2}')
info "内存 ${MEM}MB"

# 小内存机器先加 swap，否则前端构建必被 OOM 杀掉
if [ "$MEM" -lt 1800 ] && [ "$SKIP_BUILD" = "0" ]; then
  if ! swapon --show 2>/dev/null | grep -q .; then
    warn "内存偏小，创建 2G swap 以免构建时 OOM"
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
    grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    ok "swap 已启用"
  fi
fi

# ── 2. 基础依赖 ──────────────────────────────────────────────
step "2/8  基础依赖"
$INSTALL curl git nginx >/dev/null 2>&1 || die "安装基础包失败"
# pdfplumber 需要的图形库
if [ "$PKG" = "apt" ]; then
  $INSTALL libjpeg-dev zlib1g-dev >/dev/null 2>&1 || true
else
  $INSTALL libjpeg-turbo zlib >/dev/null 2>&1 || true
fi
ok "curl / git / nginx 就绪"

# ── 3. Python 3.12（uv）─────────────────────────────────────
step "3/8  Python 环境"
export PATH="/root/.local/bin:$PATH"
if ! command -v uv >/dev/null 2>&1; then
  info "安装 uv…"
  curl -LsSf https://astral.sh/uv/install.sh 2>/dev/null | sh >/dev/null 2>&1 || {
    warn "官方脚本失败，改用 pip 安装"
    $INSTALL python3-pip >/dev/null 2>&1 || true
    pip3 install -q -i https://pypi.tuna.tsinghua.edu.cn/simple uv || die "uv 安装失败"
  }
  export PATH="/root/.local/bin:$PATH"
fi
command -v uv >/dev/null 2>&1 || die "uv 不在 PATH 中"
ok "uv $(uv --version 2>/dev/null | awk '{print $2}')"

cd "$ROOT/backend"
info "安装 Python 依赖（首次约 1~3 分钟）…"
# 国内加速
export UV_DEFAULT_INDEX="${UV_DEFAULT_INDEX:-https://pypi.tuna.tsinghua.edu.cn/simple}"
uv python install 3.12 >/dev/null 2>&1 || true
uv sync --no-dev -q || die "Python 依赖安装失败"
ok "后端依赖就绪"
cd "$ROOT"

# ── 4. 前端构建 ──────────────────────────────────────────────
step "4/8  前端"
if [ "$SKIP_BUILD" = "1" ]; then
  [ -f frontend/dist/index.html ] || die "--skip-build 需要 frontend/dist 已存在（可在本地构建后上传）"
  ok "沿用已有的 frontend/dist"
else
  if ! command -v node >/dev/null 2>&1 || [ "$(node -v 2>/dev/null | tr -d 'v' | cut -d. -f1)" -lt 18 ] 2>/dev/null; then
    info "安装 Node.js 22（走国内镜像）…"
    NODE_VER=v22.14.0
    ARCH=$(uname -m); case "$ARCH" in x86_64) NARCH=x64 ;; aarch64) NARCH=arm64 ;; *) die "不支持的架构 $ARCH" ;; esac
    curl -fsSL "https://cdn.npmmirror.com/binaries/node/${NODE_VER}/node-${NODE_VER}-linux-${NARCH}.tar.xz" -o /tmp/node.tar.xz \
      || curl -fsSL "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-${NARCH}.tar.xz" -o /tmp/node.tar.xz \
      || die "Node 下载失败"
    mkdir -p /usr/local/lib/nodejs && tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs
    ln -sf "/usr/local/lib/nodejs/node-${NODE_VER}-linux-${NARCH}/bin/node" /usr/local/bin/node
    ln -sf "/usr/local/lib/nodejs/node-${NODE_VER}-linux-${NARCH}/bin/npm" /usr/local/bin/npm
    rm -f /tmp/node.tar.xz
  fi
  ok "Node $(node -v)"

  cd "$ROOT/frontend"
  npm config set registry https://registry.npmmirror.com >/dev/null 2>&1
  info "安装前端依赖…"
  npm ci --no-audit --no-fund --silent || npm install --no-audit --no-fund --silent || die "npm 安装失败"
  info "构建前端（约 1~3 分钟）…"
  NODE_OPTIONS="--max-old-space-size=1536" npm run build >/dev/null 2>&1 \
    || die "前端构建失败。内存不足的话，可在本地 npm run build 后把 dist 传上来，再执行 ./install.sh --skip-build"
  ok "前端构建完成"
  cd "$ROOT"
fi

# ── 5. 配置 ──────────────────────────────────────────────────
step "5/8  配置"
ENVF="$ROOT/backend/.env"
if [ ! -f "$ENVF" ]; then
  cp "$ROOT/.env.prod.example" "$ENVF"
  SECRET=$(openssl rand -base64 48 | tr -d '\n')
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${SECRET}|" "$ENVF"
  # 裸机部署：数据库放在项目目录下
  sed -i "s|^DATABASE_URL=.*|DATABASE_URL=sqlite+aiosqlite:///${ROOT}/backend/data/ladder.db|" "$ENVF"
  sed -i "s|^SERVE_FRONTEND=.*|SERVE_FRONTEND=true|" "$ENVF" 2>/dev/null || echo "SERVE_FRONTEND=true" >> "$ENVF"
  grep -q '^SERVE_FRONTEND=' "$ENVF" || echo "SERVE_FRONTEND=true" >> "$ENVF"
  echo "FRONTEND_DIST=${ROOT}/frontend/dist" >> "$ENVF"

  printf "\n${B}请填写配置${X}\n"
  info "必填：DEEPSEEK_API_KEY、MAAS_API_KEY、MAAS_BASE_URL"
  info "有备案域名的话再填 SITE_ADDRESS=你的域名（没有就保持 :80）"
  echo
  printf "  编辑：${B}vi %s${X}\n" "$ENVF"
  printf "  填完再执行一次：${B}./install.sh${X}\n\n"
  exit 0
fi

set -a; . "$ENVF"; set +a
[ -n "${JWT_SECRET:-}" ] && [ ${#JWT_SECRET} -ge 32 ] || die "JWT_SECRET 未设置或过短"
[ -n "${DEEPSEEK_API_KEY:-}${MAAS_API_KEY:-}" ] || die "未配置任何 LLM API key"
ok "密钥已配置"

SITE="${SITE_ADDRESS:-:80}"
mkdir -p "$ROOT/backend/data" "$ROOT/backend/logs"

# 确保关键项正确
sed -i "s|^SERVE_FRONTEND=.*|SERVE_FRONTEND=true|" "$ENVF"
grep -q '^FRONTEND_DIST=' "$ENVF" || echo "FRONTEND_DIST=${ROOT}/frontend/dist" >> "$ENVF"
sed -i "s|^APP_ENV=.*|APP_ENV=prod|" "$ENVF"
grep -q '^RATE_LIMIT_ENABLED=' "$ENVF" || echo "RATE_LIMIT_ENABLED=true" >> "$ENVF"

if [ "$SITE" = ":80" ]; then
  # HTTP 下浏览器不保存 Secure cookie → 登录成功却立刻退回登录页
  sed -i "s|^COOKIE_SECURE=.*|COOKIE_SECURE=false|" "$ENVF"
  warn "IP + HTTP 模式（已自动关闭 Secure cookie）"
else
  ok "域名模式：$SITE"
fi

# ── 6. systemd ───────────────────────────────────────────────
step "6/8  注册系统服务"
cat > /etc/systemd/system/ladder.service <<EOF
[Unit]
Description=Ladder · 以疑问为原子单位的学习工作台
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
WorkingDirectory=${ROOT}/backend
Environment="PATH=/root/.local/bin:/usr/local/bin:/usr/bin:/bin"
Environment="TZ=Asia/Shanghai"
# 单 worker：SQLite 多进程写会锁竞争
ExecStart=${ROOT}/backend/.venv/bin/uvicorn app.main:app \\
    --host 127.0.0.1 --port 8788 \\
    --proxy-headers --forwarded-allow-ips '*' \\
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
  printf "${R}✗${X} 服务启动失败：\n"
  tail -30 "$ROOT/backend/logs/server.log" 2>/dev/null || journalctl -u ladder -n 30 --no-pager
  exit 1
fi

# ── 7. Nginx ─────────────────────────────────────────────────
step "7/8  配置 Nginx"
SERVER_NAME="_"
[ "$SITE" != ":80" ] && SERVER_NAME="$SITE"

NGX_DIR=/etc/nginx/conf.d
mkdir -p "$NGX_DIR"
# Debian 系默认站点会抢占 default_server，先挪开
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

cat > "$NGX_DIR/ladder.conf" <<EOF
server {
    listen 80;
    server_name ${SERVER_NAME};

    client_max_body_size 50m;

    # 静态资源直接由 nginx 发，不经过 Python
    location /assets/ {
        alias ${ROOT}/frontend/dist/assets/;
        expires 1y;
        add_header Cache-Control "public, immutable";
        access_log off;
    }

    # ★ SSE：绝不能缓冲
    # 大纲生成约 90 秒、正文约 70 秒。漏掉 proxy_buffering off 会导致
    # 「卡住一分钟后内容突然全部涌出」，而且后端日志完全正常，极难排查。
    location /api/ {
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection '';

        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding on;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }
}
EOF

nginx -t >/dev/null 2>&1 || { nginx -t; die "Nginx 配置有误"; }
systemctl enable nginx >/dev/null 2>&1
systemctl restart nginx
ok "Nginx 已配置"

# 关掉可能拦路的本机防火墙（安全组才是真正的边界）
systemctl stop firewalld 2>/dev/null && systemctl disable firewalld 2>/dev/null && info "已关闭 firewalld" || true
command -v ufw >/dev/null 2>&1 && ufw allow 80/tcp >/dev/null 2>&1 && ufw allow 443/tcp >/dev/null 2>&1 || true

# ── 8. 自检 ──────────────────────────────────────────────────
step "8/8  自检"
sleep 2
if curl -fsS -m 10 http://127.0.0.1/api/health >/dev/null 2>&1; then
  ok "本机访问正常：$(curl -s -m 5 http://127.0.0.1/api/health)"
else
  warn "通过 Nginx 访问失败，直连后端试试："
  curl -s -m 5 http://127.0.0.1:8788/api/health || true
  tail -20 /var/log/nginx/error.log 2>/dev/null || true
fi

"$ROOT/backend/.venv/bin/python" "$ROOT/backend/scripts/preflight.py" 2>/dev/null || true

# ── 完成 ─────────────────────────────────────────────────────
IP=$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
printf "\n${B}部署完成${X}\n\n"
if [ "$SITE" = ":80" ]; then
  printf "  访问地址  ${B}http://%s${X}\n\n" "$IP"
  warn "打不开的话，99% 是${B}阿里云安全组没放行 80 端口${X}"
  info "控制台 → ECS 实例 → 安全组 → 配置规则 → 入方向 → 手动添加 80/80，0.0.0.0/0"
else
  printf "  访问地址  ${B}http://%s${X}\n" "$SITE"
  info "配 HTTPS：certbot --nginx -d $SITE   （需 80/443 均已放行且域名已备案）"
fi
cat <<TIP

  常用命令
    systemctl status ladder          查看状态
    systemctl restart ladder         重启
    tail -f ${ROOT}/backend/logs/server.log    实时日志
    cd ${ROOT} && git pull && ./install.sh     更新部署

  注册第一个账号后，建议编辑 backend/.env 把 ALLOW_REGISTRATION 改为 false，
  然后 systemctl restart ladder，避免陌生人消耗 API 额度。

TIP
