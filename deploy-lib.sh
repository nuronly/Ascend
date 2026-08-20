#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════
#  阶梯 · 部署脚本公共库
#  被 install.sh / deploy.sh / deploy-contest.sh / update.sh 共同 source
#
#  为什么需要这个文件：
#  仓库里有三条**互斥**的部署路线，它们抢同一个 systemd 单元名
#  （ladder.service）和同一份 backend/.env。一旦在同一台机器上先后
#  跑了两条，症状极其迷惑 —— systemctl 显示 active、Nginx 也正常，
#  但监听端口已经换了，外面怎么都连不上，排查方向全被带偏。
#
#  所以「这台机器现在是哪条路线」必须被记录下来并在每次部署前核对，
#  而且这套逻辑只能有一份实现，不能三个脚本各写一遍各错一遍。
# ═════════════════════════════════════════════════════════════

# 调用方应先设好 LADDER_ROOT（仓库根目录）
LADDER_ROOT="${LADDER_ROOT:-$(pwd)}"
LADDER_MODE_FILE="${LADDER_ROOT}/.deploy-mode"
LADDER_UNIT=/etc/systemd/system/ladder.service
LADDER_NGX_CONF=/etc/nginx/conf.d/ladder.conf

# ── 模式说明（给人看的）──
ladder_mode_desc() {
  case "$1" in
    bare)    echo "裸机 + Nginx 反代 · install.sh" ;;
    contest) echo "单体直连、无反代 · deploy-contest.sh" ;;
    docker)  echo "Docker + Caddy · deploy.sh" ;;
    *)       echo "未知（$1）" ;;
  esac
}

# ── 从 systemd 单元里抠出实际监听端口 ──
# 比任何写死的默认值都可靠：脚本可以用 PORT= 改端口，猜是猜不准的。
ladder_service_port() {
  [ -f "$LADDER_UNIT" ] || return 1
  sed -n 's/.*--port[= ]*\([0-9]\{2,5\}\).*/\1/p' "$LADDER_UNIT" | head -1
}

# ── 当前机器上已经部署过什么 ──
# 先看标记文件；没有就从现场痕迹推断 —— 标记文件是后来才加的，
# 已经在跑的老机器上并不存在，不能因为没有标记就认不出来。
ladder_mode_detect() {
  if [ -s "$LADDER_MODE_FILE" ]; then
    tr -d '[:space:]' < "$LADDER_MODE_FILE"
    return 0
  fi
  if command -v docker >/dev/null 2>&1 &&
     (cd "$LADDER_ROOT" && docker compose ps -q 2>/dev/null | grep -q .); then
    echo docker
    return 0
  fi
  if [ -f "$LADDER_UNIT" ]; then
    # 有 Nginx 站点配置 = 反代路线；没有 = 单体直连
    if [ -f "$LADDER_NGX_CONF" ]; then echo bare; else echo contest; fi
    return 0
  fi
  echo ""
}

ladder_mode_write() {
  printf '%s\n' "$1" > "$LADDER_MODE_FILE"
}

# ── 切换路线前，把旧的那套停干净 ──
# 不停的话，残留的反代或容器会继续占着 80/443，新路线起不来。
ladder_mode_stop() {
  case "$1" in
    docker)
      (cd "$LADDER_ROOT" && { docker compose down || docker-compose down; }) >/dev/null 2>&1 || true
      ;;
    bare)
      systemctl stop ladder >/dev/null 2>&1 || true
      rm -f "$LADDER_NGX_CONF"
      systemctl reload nginx >/dev/null 2>&1 || systemctl stop nginx >/dev/null 2>&1 || true
      ;;
    contest)
      systemctl stop ladder >/dev/null 2>&1 || true
      ;;
  esac
}

# ── 部署前互检 ──
# 换路线是允许的，但必须是明确的决定。默默覆盖等于把站点弄没。
ladder_mode_assert() {
  local want="$1" have
  have=$(ladder_mode_detect)
  [ -z "$have" ] && return 0
  if [ "$have" = "$want" ]; then
    ladder_mode_write "$want"
    return 0
  fi

  if [ "${FORCE_SWITCH:-0}" = "1" ]; then
    printf '\033[33m!\033[0m 部署方式切换：%s → %s（FORCE_SWITCH=1）\n' \
      "$(ladder_mode_desc "$have")" "$(ladder_mode_desc "$want")"
    ladder_mode_stop "$have"
    printf '\033[33m!\033[0m 已停掉旧的那套\n'
    return 0
  fi

  printf '\033[31m✗\033[0m 这台机器已经用另一种方式部署过了\n\n'
  printf '    现在是   %s\n'   "$(ladder_mode_desc "$have")"
  printf '    你在跑   %s\n\n' "$(ladder_mode_desc "$want")"
  printf '  两条路线抢同一个 systemd 单元和同一份 backend/.env。直接覆盖的后果是\n'
  printf '  站点失联：服务显示 active，但监听端口已经变了，外面连不上，\n'
  printf '  而日志里什么异常都没有 —— 非常难查。\n\n'
  printf '  想继续用现在这套 → 执行对应的脚本：\n'
  case "$have" in
    bare)    printf '      ./install.sh\n\n' ;;
    contest) printf '      ./deploy-contest.sh\n\n' ;;
    docker)  printf '      ./deploy.sh\n\n' ;;
  esac
  printf '  确实要换过去 → 带上 FORCE_SWITCH=1 重跑（会先把旧的停掉）：\n'
  printf '      FORCE_SWITCH=1 ./%s\n\n' "${0##*/}"
  exit 1
}

# ── 探测公网 IP ──
# 绝不能把内网地址打出来：用户照着连不上，又很容易归因成安全组问题，
# 白排查半天。探不到就明说，比给个错的好。
ladder_public_ip() {
  local url raw ip
  for url in https://api.ipify.org https://ifconfig.me https://ip.sb https://myip.ipip.net; do
    raw=$(curl -fsS -m 4 "$url" 2>/dev/null || true)
    # ipip.net 返回的是一整句中文，所以从文本里提取而不是整串匹配
    ip=$(printf '%s' "$raw" | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1)
    [ -n "$ip" ] || continue
    case "$ip" in
      10.*|127.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) continue ;;
      100.6[4-9].*|100.[7-9][0-9].*|100.1[0-2][0-9].*) continue ;;
      *) printf '%s' "$ip"; return 0 ;;
    esac
  done
  return 1
}

# ── 放行本机防火墙端口 ──
# 真正的边界是云平台安全组，但本机这层也常常拦着，症状一模一样：
# 服务器上 curl 完全正常，外面就是打不开。这里只加规则，不关防火墙。
ladder_open_port() {
  local port="$1"
  if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="${port}/tcp" >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 || true
  fi
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    ufw allow "${port}/tcp" >/dev/null 2>&1 || true
  fi
}

# ── 在 .env 里设定某个键（有则改，无则加）──
# 「sed 改一行 + grep 兜底追加」这套写了太多遍，错一处就是一个静默失效的配置
# —— 而且 sed 的替换串要转义 & 和分隔符，JWT_SECRET、DATABASE_URL 这类值里
# 恰好带着 / + & ，转义漏一个就写出一份坏配置。这里用 awk 按整行替换。
#
# 两个细节都是踩出来的：
#   · 走 ENVIRON 而不是 awk -v ——  -v 赋值会解释转义序列，值里的 \ 会被
#     悄悄吃掉（SMTP 授权码这类值就可能带 \）。
#   · 用 `cat > file` 而不是 mv —— 保留原文件的权限与 inode（.env 里是密钥，
#     mv 过去权限会变成 umask 决定的，可能变成全局可读）。
ladder_env_set() {
  local file="$1" key="$2" value="$3" tmp
  tmp="${file}.tmp.$$"
  LADDER_ENV_K="$key" LADDER_ENV_V="$value" awk '
    BEGIN { k = ENVIRON["LADDER_ENV_K"]; v = ENVIRON["LADDER_ENV_V"] }
    $0 ~ "^" k "=" { if (!done) { print k "=" v; done = 1 } ; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$file" > "$tmp" && cat "$tmp" > "$file"
  rm -f "$tmp"
}

# ── 对齐某条路线必须成立的配置 ──
# 放在库里而不是各自的部署脚本里，是为了让 update.sh 的「只重启后端」快路径
# 也能走一遍。否则新增的强制项要等到下一次全量部署才生效 —— 而那可能是几周
# 之后，中间这段时间防护看着是开的，实际没生效，谁都不会发现。
#
# 只放「这条路线成立就必然如此」的项。COOKIE_SECURE 在裸机路线上取决于
# 有没有配 HTTPS，判断逻辑在 install.sh 里，这里不碰；DATABASE_URL 也不碰
# —— 用户可能把库挪到别处去了。
ladder_apply_mode_env() {
  local mode="$1" file="$2" root="$3"
  [ -f "$file" ] || return 1
  ladder_env_set "$file" APP_ENV prod
  ladder_env_set "$file" SERVE_FRONTEND true
  ladder_env_set "$file" FRONTEND_DIST "${root}/frontend/dist"
  ladder_env_set "$file" RATE_LIMIT_ENABLED true
  case "$mode" in
    contest)
      # 没有反代：一律 HTTP，且转发头完全由客户端伪造，不能信
      ladder_env_set "$file" COOKIE_SECURE false
      ladder_env_set "$file" TRUST_PROXY_HEADERS false
      ;;
    bare|docker)
      # 反代会覆写转发头，可信、而且必须用它，否则所有人被算成同一个 IP
      ladder_env_set "$file" TRUST_PROXY_HEADERS true
      ;;
  esac
}

# ── 备份数据库（有库才备份）──
# 有真实用户数据的机器上，重新部署前必须留一个回退点：
# 这次 pull 可能带了 schema 变更，出问题就回不去了。
# 必须走 backup.py —— 直接 cp 在 WAL 模式下会拿到一个几乎空的库。
ladder_backup_db() {
  local py="$LADDER_ROOT/backend/.venv/bin/python"
  local db="$LADDER_ROOT/backend/data/ladder.db"
  [ -f "$db" ] || return 2
  [ -x "$py" ] || return 1
  (cd "$LADDER_ROOT/backend" && "$py" scripts/backup.py) >/dev/null 2>&1
}
