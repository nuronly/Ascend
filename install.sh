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
LADDER_ROOT="$ROOT"
# shellcheck source=deploy-lib.sh
. "$ROOT/deploy-lib.sh"

B=$'\033[1m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; D=$'\033[2m'; X=$'\033[0m'
# 第二个参数是补充说明（暗色显示）。原来只取 $1，有三处调用传了两个参数，
# 第二个被静默丢弃 —— 丢掉的恰恰是健康检查响应体、探测到的域名这类
# 排障时最想看的东西。
# 颜色序列包在 ${2:+} 里面：没有第二个参数时一个转义字符都不输出。
ok()   { printf "${G}✓${X} %s\n" "$1${2:+  ${D}$2${X}}"; }
warn() { printf "${Y}!${X} %s\n" "$1${2:+  ${D}$2${X}}"; }
die()  { printf "${R}✗${X} %s\n" "$1${2:+  ${D}$2${X}}"; exit 1; }
step() { printf "\n${B}%s${X}\n" "$1"; }
info() { printf "  ${D}%s${X}\n" "$1"; }

SKIP_BUILD=0
[[ "${1:-}" == "--skip-build" ]] && SKIP_BUILD=1

[ "$(id -u)" = "0" ] || die "请用 root 运行：sudo ./install.sh"

# 这台机器是不是已经被另一条路线部署过了 —— 三者抢同一个 systemd 单元，
# 默默覆盖会让站点失联（服务显示 active，监听端口却变了）
ladder_mode_assert bare

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
  # ★ 必须真的把 node 跑起来才算数，不能只看 command -v。
  #   conda 之类的环境里常留着失效的 node 软链/shim：命令查得到、一执行就
  #   command not found。原来的判断因此跳过安装，接着无条件打印「✓ Node」，
  #   npm 全部静默失败，脚本一路绿灯走完 —— 前端其实一次都没构建，
  #   而用户只会看到「更新完了但界面纹丝不动」。
  # 只用 bash 内建做版本解析，不依赖 tr/cut —— 少一个能出岔子的环节
  node_ok() {
    local v
    v=$(node -v 2>/dev/null) || return 1
    v=${v#v}
    v=${v%%.*}
    [ "${v:-0}" -ge 18 ] 2>/dev/null
  }

  if ! node_ok; then
    command -v node >/dev/null 2>&1 && warn "已有的 node 不可用或版本过低，重新安装"
    info "安装 Node.js 22（走国内镜像）…"
    NODE_VER=v22.14.0
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
    # conda 等环境可能把自己的 bin 排在 /usr/local/bin 前面，抢走 node
    export PATH="$NODE_HOME:$PATH"
    hash -r 2>/dev/null || true
  fi

  node_ok || die "Node 装完仍然跑不起来：$(command -v node || echo '不在 PATH 中')
  多半是 PATH 里有失效的 node（conda / nvm 残留）。可执行：
    which -a node          # 看是谁在抢
    /usr/local/bin/node -v # 确认新装的能跑"
  ok "Node $(node -v)"

  cd "$ROOT/frontend"
  npm config set registry https://registry.npmmirror.com >/dev/null 2>&1
  info "安装前端依赖…"
  npm ci --no-audit --no-fund --silent || npm install --no-audit --no-fund --silent || die "npm 安装失败"

  # 构建日志落盘。原来 >/dev/null 2>&1 把一切吞掉，构建失败时
  # 只剩一句「构建失败」，OOM 还是语法错完全分不出来
  info "构建前端（约 1~3 分钟）…"
  BUILD_LOG=/tmp/ladder-build.log
  if ! NODE_OPTIONS="--max-old-space-size=1536" npm run build >"$BUILD_LOG" 2>&1; then
    tail -25 "$BUILD_LOG"
    die "前端构建失败，完整日志见 $BUILD_LOG
  若是内存不足（Killed / heap out of memory），可在本地 npm run build 后
  把 frontend/dist 传上来，再执行 ./install.sh --skip-build"
  fi
  ok "前端构建完成（$(grep -oE 'index-[A-Za-z0-9_-]+\.js' dist/index.html | head -1)）"
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

# 确保关键项正确。含 TRUST_PROXY_HEADERS=true —— 这条路线后端在 Nginx 之后，
# X-Forwarded-For 由反代覆写（见下面的 proxy_set_header），所以可信、而且必须
# 用它：否则限流会把所有人算成反代本机那一个 IP，一个人触发限流就把全站挡在门外。
# （实现在 deploy-lib.sh，update.sh 的快路径调的是同一个函数）
ladder_apply_mode_env bare "$ENVF" "$ROOT"

# 站点到底跑没跑 HTTPS，不能只看 SITE_ADDRESS。
# 用户可能手工给 Nginx 配好了证书（甚至加了 HTTP→HTTPS 跳转），
# 而 SITE_ADDRESS 还停在 IP 模式 —— 这时把 Secure cookie 关掉就是错的：
# 浏览器走的是 https，配置却按 http 来，两边对不上。
# 所以直接从现有 Nginx 配置里把真实域名挖出来。
nginx_https_host() {
  local f=/etc/nginx/conf.d/ladder.conf
  [ -f "$f" ] || return 1
  grep -qE 'ssl_certificate|listen[[:space:]]+443' "$f" || return 1
  # 两段过滤而不是 grep -vxE '_|'：空分支在 BSD grep 上会直接报错
  sed -n 's/^[[:space:]]*server_name[[:space:]]*\(.*\);.*/\1/p' "$f" \
    | tr ' ' '\n' | grep -v '^[[:space:]]*$' | grep -vx '_' | head -1
}

HTTPS_HOST=""
if [ "$SITE" != ":80" ]; then
  HTTPS_HOST="$SITE"
elif HOST_FROM_NGX=$(nginx_https_host) && [ -n "$HOST_FROM_NGX" ]; then
  HTTPS_HOST="$HOST_FROM_NGX"
  warn "SITE_ADDRESS 是 IP 模式，但 Nginx 已配好 HTTPS" "按域名 $HTTPS_HOST 处理"
fi

if [ -z "$HTTPS_HOST" ]; then
  # HTTP 下浏览器不回传 Secure cookie → 登录成功却立刻退回登录页
  sed -i "s|^COOKIE_SECURE=.*|COOKIE_SECURE=false|" "$ENVF"
  warn "IP + HTTP 模式（已自动关闭 Secure cookie）"
else
  # HTTPS：必须打开 Secure，并把 CORS / 公开地址同步到域名
  sed -i "s|^COOKIE_SECURE=.*|COOKIE_SECURE=true|" "$ENVF"
  sed -i "s|^CORS_ORIGINS=.*|CORS_ORIGINS=https://${HTTPS_HOST}|" "$ENVF"
  sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=https://${HTTPS_HOST}|" "$ENVF"
  ok "HTTPS 模式：$HTTPS_HOST（Secure cookie 与 CORS 已同步）"
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
# 记下部署方式：另外两个脚本会据此拒绝覆盖，update.sh 也靠它选择更新路径
ladder_mode_write bare
sleep 5

if systemctl is-active --quiet ladder; then
  ok "服务已启动"
else
  printf "${R}✗${X} 服务启动失败：\n"
  tail -30 "$ROOT/backend/logs/server.log" 2>/dev/null || journalctl -u ladder -n 30 --no-pager
  exit 1
fi

# ── 日志轮转 ─────────────────────────────────────────────────
# server.log 是纯 append：uvicorn access log + 应用 logger（LLM 报错时的
# traceback）全在这里，长跑会无限长大。磁盘满 → SQLite 写不进 → 服务挂。
# 注意必须 copytruncate：systemd 持有文件 fd 持续写入，直接 mv 旧文件会让
# 日志继续写进已删除的 inode —— 日志消失，空间还不释放。
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
  ok "日志轮转：每日或超 200M 触发，留 14 份"
else
  warn "logrotate 装不上，日志会无限增长。应急截断：> $ROOT/backend/logs/server.log"
fi

# ── 7. Nginx ─────────────────────────────────────────────────
step "7/8  配置 Nginx"
SERVER_NAME="_"
[ "$SITE" != ":80" ] && SERVER_NAME="$SITE"

NGX_DIR=/etc/nginx/conf.d
NGX_CONF="$NGX_DIR/ladder.conf"
mkdir -p "$NGX_DIR"
# Debian 系默认站点会抢占 default_server，先挪开
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

# ★ 绝不能因为一次例行更新就把用户的 HTTPS 配置冲掉。
#   证书签发、SSL 段落往往是手工调过的，覆盖掉等于站点从 HTTPS 掉回 HTTP，
#   而且用户多半要等到浏览器报警才发现。
if [ -f "$NGX_CONF" ] && grep -qE 'ssl_certificate|listen[[:space:]]+443' "$NGX_CONF"; then
  BAK="$NGX_CONF.bak.$(date +%Y%m%d-%H%M%S)"
  cp "$NGX_CONF" "$BAK"
  warn "检测到已有 HTTPS 配置，保留不覆盖（已备份 $(basename "$BAK")）"
  info "如需重置回默认 HTTP 配置：rm $NGX_CONF 后重跑本脚本"
  # 静态资源路径可能随部署目录变化，这里只做校验不改写
  grep -q "${ROOT}/frontend/dist/assets/" "$NGX_CONF" \
    || warn "现有配置里的 /assets/ 路径与当前目录 ${ROOT} 不一致，前端静态资源可能 404"
  grep -q 'proxy_buffering off' "$NGX_CONF" \
    || warn "现有配置缺少 proxy_buffering off —— SSE 会表现为「卡住很久后内容突然涌出」"
  NGX_KEPT=1
else
  NGX_KEPT=0
  cat > "$NGX_CONF" <<EOF
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
fi

nginx -t >/dev/null 2>&1 || { nginx -t; die "Nginx 配置有误"; }
systemctl enable nginx >/dev/null 2>&1
systemctl restart nginx
[ "$NGX_KEPT" = "1" ] && ok "Nginx 已重载（沿用现有 HTTPS 配置）" || ok "Nginx 已配置"

# 关掉可能拦路的本机防火墙（安全组才是真正的边界）
systemctl stop firewalld 2>/dev/null && systemctl disable firewalld 2>/dev/null && info "已关闭 firewalld" || true
command -v ufw >/dev/null 2>&1 && ufw allow 80/tcp >/dev/null 2>&1 && ufw allow 443/tcp >/dev/null 2>&1 || true

# ── 8. 自检 ──────────────────────────────────────────────────
step "8/8  自检"
sleep 2

# 先直连后端，绕开 Nginx —— 分清是「服务没起来」还是「代理配错了」
BACKEND_BODY=$(curl -fsS -m 10 http://127.0.0.1:8788/api/health 2>/dev/null || echo '')
case "$BACKEND_BODY" in
  *'"status":"ok"'*) ok "后端正常" "$BACKEND_BODY" ;;
  *)
    warn "后端直连失败，最近日志："
    tail -20 "$ROOT/backend/logs/server.log" 2>/dev/null || true
    ;;
esac

# 再走一遍 Nginx。必须加 -L：站点一旦配了 HTTPS，HTTP 会被 301 跳走，
# 而 curl -fsS 不把 301 当失败 —— 原来的写法会把一张「301 Moved Permanently」
# 的 HTML 当作健康检查通过，等于什么都没验证到
NGX_BODY=$(curl -fsSL -k -m 12 http://127.0.0.1/api/health 2>/dev/null || echo '')
case "$NGX_BODY" in
  *'"status":"ok"'*) ok "Nginx 代理正常" ;;
  '')
    warn "通过 Nginx 访问不通"
    tail -10 /var/log/nginx/error.log 2>/dev/null || true
    ;;
  *)
    warn "通过 Nginx 拿到的不是健康检查响应" "$(printf '%.80s' "$NGX_BODY")"
    ;;
esac

"$ROOT/backend/.venv/bin/python" "$ROOT/backend/scripts/preflight.py" 2>/dev/null || true

# ── 完成 ─────────────────────────────────────────────────────
# 公网 IP 探测放在 deploy-lib.sh：三个脚本都要用，这种"绝不能打印内网段"
# 的判断只能有一份实现
IP=$(ladder_public_ip || true)
printf "\n${B}部署完成${X}\n\n"
if [ "$SITE" = ":80" ]; then
  if [ -n "${IP:-}" ]; then
    printf "  访问地址  ${B}http://%s${X}\n\n" "$IP"
  else
    # 探测不到就明说，绝不能打印内网 IP（172.x / 10.x / 192.168.x）误导
    printf "  访问地址  ${B}http://<你的公网IP>${X}\n\n"
    warn "未能自动探测公网 IP —— 到阿里云控制台 ECS 实例详情页查看「公网 IP」"
    info "注意区分：172.x.x.x / 10.x.x.x / 192.168.x.x 都是内网 IP，外部访问不了"
  fi
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
