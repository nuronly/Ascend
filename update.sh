#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════
#  阶梯 · 一键更新（服务器上执行）
#
#      cd /opt/ladder && sudo ./update.sh
#
#  做的事：
#    1. 处理 git 的 dubious ownership（root 操作非 root 克隆的仓库会被拒）
#    2. git pull（会先暂存服务器上的本地改动，避免冲突中断）
#    3. 只有前端代码变了才重新构建；纯后端改动只重启服务，几秒钟完事
#    4. 验证服务确实加载了新代码
# ═════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

B=$'\033[1m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; D=$'\033[2m'; X=$'\033[0m'
ok()   { printf "${G}✓${X} %s\n" "$1"; }
warn() { printf "${Y}!${X} %s\n" "$1"; }
die()  { printf "${R}✗${X} %s\n" "$1"; exit 1; }

# root 操作非 root 克隆的仓库时，git 会以 dubious ownership 拒绝 —
# 报错混在一堆输出里极容易被忽略，结果"更新了"其实一行代码都没变。
git config --global --add safe.directory "$ROOT" 2>/dev/null || true

OLD=$(git rev-parse HEAD)

# 服务器上的本地改动（如果有）先暂存，pull 完再恢复
STASHED=0
if ! git diff --quiet || ! git diff --cached --quiet; then
  git stash push -q -m "update.sh 自动暂存" && STASHED=1
  warn "服务器上有本地改动，已暂存（更新后自动恢复）"
fi

git pull --ff-only -q || die "git pull 失败。执行 git log --oneline -3 和 git status 把输出发给开发者"
NEW=$(git rev-parse HEAD)
[ "$STASHED" = "1" ] && git stash pop -q || true

if [ "$OLD" = "$NEW" ]; then
  ok "已是最新（${NEW:0:7}），无需更新"
else
  ok "已更新 ${OLD:0:7} → ${NEW:0:7}"
  git --no-pager log --oneline "$OLD..$NEW" | sed 's/^/    /'
fi

# 前端没动就只重启后端 —— 前端构建要几分钟，后端重启只要几秒
if [ "$OLD" != "$NEW" ] && git diff --name-only "$OLD" "$NEW" | grep -q '^frontend/'; then
  printf "\n${B}前端有变化，完整重装…${X}\n"
  exec ./install.sh
else
  printf "\n${B}重启后端…${X}\n"
  systemctl restart ladder
  sleep 4
  systemctl is-active --quiet ladder || {
    tail -20 backend/logs/server.log
    die "重启失败，日志见上"
  }
  ok "服务已重启"
fi

# 验证新代码真的生效了。
# 注意：探测时必须让 Host 与 Origin 一致（模拟浏览器的真实同源请求），
# 否则 CSRF 中间件会正确地把它们拦下，造成"修复没生效"的误判。
printf "\n${B}验证…${X}\n"
HOST_IP=$(grep -oE '^SITE_ADDRESS=.*' backend/.env 2>/dev/null | cut -d= -f2 | tr -d ' ')
[ -z "$HOST_IP" ] || [ "$HOST_IP" = ":80" ] && HOST_IP="127.0.0.1"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 10 -X POST http://127.0.0.1/api/auth/login \
  -H "Content-Type: application/json" \
  -H "Host: ${HOST_IP}" \
  -H "Origin: http://${HOST_IP}" \
  -d '{"email":"probe@example.com","password":"probe-password"}' || echo "000")
case "$CODE" in
  401|200) ok "同源请求正常通过（$CODE）" ;;
  403) die "仍返回 403 —— 服务没加载到新代码，把 backend/logs/server.log 末尾发给开发者" ;;
  *) warn "探测返回 $CODE，手动验证：curl http://127.0.0.1/api/health" ;;
esac

printf "\n${G}更新完成${X}\n"
