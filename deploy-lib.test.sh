#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════
#  deploy-lib.sh 的自测。本机直接跑，不需要 root，不碰任何系统路径：
#      ./deploy-lib.test.sh
#
#  为什么值得有：这个库里的函数出错时症状都是「静默写坏一份配置」
#  或「认错部署路线」，在服务器上极难发现 —— 第一次跑它就抓到了
#  awk -v 会把值里的反斜杠吃掉的问题。
# ═════════════════════════════════════════════════════════════
set -uo pipefail
cd "$(dirname "$0")"

PASS=0; FAIL=0
t() {
  if [ "$2" = "$3" ]; then
    PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"
  else
    FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n      期望 [%s]\n      实际 [%s]\n' "$1" "$2" "$3"
  fi
}

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

export LADDER_ROOT="$WORK"
# shellcheck source=deploy-lib.sh
. ./deploy-lib.sh
# 绝不碰真实系统路径
LADDER_UNIT="$WORK/ladder.service"
LADDER_NGX_CONF="$WORK/nginx-ladder.conf"

printf '\n\033[1mladder_env_set\033[0m\n'
ENVF="$WORK/.env"
printf 'APP_ENV=dev\nJWT_SECRET=\nCOOKIE_SECURE=true\n' > "$ENVF"
chmod 600 "$ENVF"

ladder_env_set "$ENVF" APP_ENV prod
t "覆盖已有键" "prod" "$(grep '^APP_ENV=' "$ENVF" | cut -d= -f2-)"

# base64 里带 / + = ，再叠上 sed 最怕的 & | \ —— 这是最容易被写坏的一类值
SECRET='ab/cd+ef=gh&ij|kl\mn'
ladder_env_set "$ENVF" JWT_SECRET "$SECRET"
t "含 / + = & | \\ 的值原样落盘" "$SECRET" "$(grep '^JWT_SECRET=' "$ENVF" | cut -d= -f2-)"

ladder_env_set "$ENVF" TRUST_PROXY_HEADERS false
t "追加不存在的键" "false" "$(grep '^TRUST_PROXY_HEADERS=' "$ENVF" | cut -d= -f2-)"

ladder_env_set "$ENVF" APP_ENV prod
ladder_env_set "$ENVF" APP_ENV prod
t "重复设置不会产生第二行" "1" "$(grep -c '^APP_ENV=' "$ENVF" | tr -d ' ')"

t "保留原文件权限（.env 是密钥）" "600" "$(stat -f '%Lp' "$ENVF" 2>/dev/null || stat -c '%a' "$ENVF")"

DBURL='sqlite+aiosqlite:////opt/ladder/backend/data/ladder.db'
ladder_env_set "$ENVF" DATABASE_URL "$DBURL"
t "含多重斜杠的 URL" "$DBURL" "$(grep '^DATABASE_URL=' "$ENVF" | cut -d= -f2-)"
t "其它键没被弄坏" "true" "$(grep '^COOKIE_SECURE=' "$ENVF" | cut -d= -f2-)"

printf '\n\033[1m部署模式互检\033[0m\n'
t "全新机器：认不出模式，返回空" "" "$(ladder_mode_detect)"

ladder_mode_write contest
t "写入后能读回" "contest" "$(ladder_mode_detect)"

( ladder_mode_assert contest ) >/dev/null 2>&1
t "同一路线重复执行 → 放行" "0" "$?"

( ladder_mode_assert bare ) >/dev/null 2>&1
t "路线冲突 → 拒绝执行" "1" "$?"

( FORCE_SWITCH=1 ladder_mode_assert bare ) >/dev/null 2>&1
t "FORCE_SWITCH=1 → 允许切换" "0" "$?"

rm -f "$WORK/.deploy-mode"
: > "$LADDER_UNIT"
t "无标记文件：按 systemd 单元推断为单体" "contest" "$(ladder_mode_detect)"
: > "$LADDER_NGX_CONF"
t "无标记文件：有 Nginx 站点配置则为裸机" "bare" "$(ladder_mode_detect)"
rm -f "$LADDER_NGX_CONF"

printf '\n\033[1mladder_service_port\033[0m\n'
printf 'ExecStart=/opt/ladder/backend/.venv/bin/uvicorn app.main:app \\\n    --host 0.0.0.0 --port 8000 \\\n    --timeout-keep-alive 75\n' > "$LADDER_UNIT"
t "单体单元（端口在续行里）" "8000" "$(ladder_service_port)"

printf 'ExecStart=/x/uvicorn app.main:app --host 127.0.0.1 --port 8788 --proxy-headers\n' > "$LADDER_UNIT"
t "裸机单元" "8788" "$(ladder_service_port)"

printf 'ExecStart=/x/uvicorn app.main:app --host 0.0.0.0 --port 9000\n' > "$LADDER_UNIT"
t "自定义端口" "9000" "$(ladder_service_port)"

rm -f "$LADDER_UNIT"
( ladder_service_port ) >/dev/null 2>&1
t "没有单元文件时返回非 0" "1" "$?"

printf '\n\033[1mladder_apply_mode_env\033[0m\n'
ENV2="$WORK/.env2"
printf 'APP_ENV=dev\nCOOKIE_SECURE=true\n' > "$ENV2"
ladder_apply_mode_env contest "$ENV2" /opt/ladder
t "单体路线：关掉 Secure cookie" "false" "$(grep '^COOKIE_SECURE=' "$ENV2" | cut -d= -f2-)"
t "单体路线：不信任转发头" "false" "$(grep '^TRUST_PROXY_HEADERS=' "$ENV2" | cut -d= -f2-)"
t "单体路线：静态前端路径按部署目录走" "/opt/ladder/frontend/dist" "$(grep '^FRONTEND_DIST=' "$ENV2" | cut -d= -f2-)"
t "单体路线：强制开启限流" "true" "$(grep '^RATE_LIMIT_ENABLED=' "$ENV2" | cut -d= -f2-)"
t "单体路线：强制 prod" "prod" "$(grep '^APP_ENV=' "$ENV2" | cut -d= -f2-)"

printf 'APP_ENV=dev\nCOOKIE_SECURE=true\nDATABASE_URL=sqlite+aiosqlite:////custom/x.db\n' > "$ENV2"
ladder_apply_mode_env bare "$ENV2" /opt/ladder
t "裸机路线：信任转发头" "true" "$(grep '^TRUST_PROXY_HEADERS=' "$ENV2" | cut -d= -f2-)"
t "裸机路线：不碰 COOKIE_SECURE（由 HTTPS 探测决定）" "true" "$(grep '^COOKIE_SECURE=' "$ENV2" | cut -d= -f2-)"
t "不覆盖用户自定义的数据库路径" "sqlite+aiosqlite:////custom/x.db" "$(grep '^DATABASE_URL=' "$ENV2" | cut -d= -f2-)"

( ladder_apply_mode_env contest "$WORK/并不存在.env" /opt/ladder ) >/dev/null 2>&1
t "配置文件不存在时返回非 0" "1" "$?"

printf '\n\033[1mladder_public_ip\033[0m\n'
IP=$(ladder_public_ip || true)
if [ -n "$IP" ]; then
  PASS=$((PASS+1)); printf '  \033[32m✓\033[0m 探测到 %s\n' "$IP"
  case "$IP" in
    10.*|127.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*)
      t "绝不能返回内网地址" "<公网IP>" "$IP" ;;
    *) PASS=$((PASS+1)); printf '  \033[32m✓\033[0m 不是内网地址\n' ;;
  esac
else
  printf '  \033[33m!\033[0m 探测不到（本机无外网时属正常）\n'
fi

printf '\n──────────────────────\n通过 %s · 失败 %s\n\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ]
