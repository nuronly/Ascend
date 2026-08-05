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
# 精简过的系统镜像里可能没有 timeout，缺了也不该让整个脚本挂掉
run_timeout() {
  if command -v timeout >/dev/null 2>&1; then timeout "$@"; else shift; "$@"; fi
}

# root 操作非 root 克隆的仓库时，git 会以 dubious ownership 拒绝 —
# 报错混在一堆输出里极容易被忽略，结果"更新了"其实一行代码都没变。
git config --global --add safe.directory "$ROOT" 2>/dev/null || true

OLD=$(git rev-parse HEAD)
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)
[ "$BRANCH" = "HEAD" ] && BRANCH=main

# 服务器上的本地改动（如果有）先暂存，pull 完再恢复
STASHED=0

# 无论脚本怎么退出（包括 die 和 Ctrl+C），暂存的改动都必须还回去。
# 否则用户的本地修改会悄无声息地留在 stash 里，下次更新又叠一层，最后没人记得。
restore_stash() {
  [ "$STASHED" = "1" ] || return 0
  STASHED=0
  if git stash pop -q 2>/dev/null; then
    warn "已恢复服务器上的本地改动"
  else
    warn "本地改动恢复失败（多半是与新代码冲突），内容仍在：git stash list / git stash pop"
  fi
}
trap restore_stash EXIT INT TERM

if ! git diff --quiet || ! git diff --cached --quiet; then
  git stash push -q -m "update.sh 自动暂存" && STASHED=1
  warn "服务器上有本地改动，已暂存（更新后自动恢复）"
fi

# GitHub 在国内服务器上经常被重置（典型报错：Empty reply from server / TLS handshake failure）。
# 这时脚本不该直接躺倒 —— 依次退到公共镜像。
# 另外这里刻意不加 -q：静默的 pull 卡住时，用户看到的只是一个不动的光标，
# 完全无法判断是在下载、在等网络、还是在等着输密码。
UPSTREAM=$(git remote get-url origin 2>/dev/null || echo '')
MIRRORS=("")
case "$UPSTREAM" in
  https://*) MIRRORS+=("https://ghfast.top/" "https://gh-proxy.com/" "https://ghproxy.net/") ;;
esac

PULLED=0
for M in "${MIRRORS[@]}"; do
  if [ -z "$M" ]; then
    LABEL="origin"; SRC="origin"
  else
    LABEL="镜像 $(echo "$M" | cut -d/ -f3)"; SRC="${M}${UPSTREAM}"
  fi
  printf "${D}  拉取（%s）…${X}\n" "$LABEL"
  # GIT_TERMINAL_PROMPT=0：仓库若变成私有，宁可立刻失败也不要卡在密码提示上
  if GIT_TERMINAL_PROMPT=0 run_timeout 120 git pull --ff-only "$SRC" "$BRANCH"; then
    PULLED=1
    [ -n "$M" ] && warn "直连 GitHub 失败，本次经由 $LABEL 更新"
    break
  fi
  warn "$LABEL 不通"
done

[ "$PULLED" = "1" ] || die "所有源都拉不下来。可在本机执行：
    rsync -avz --delete --exclude node_modules --exclude .venv --exclude dist \\
      --exclude '*.db*' --exclude .env --exclude .git ./ root@<服务器IP>:$ROOT/
  然后在服务器上直接执行 ./install.sh"

NEW=$(git rev-parse HEAD)
restore_stash

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
  # 清掉字节码缓存 —— 服务器时钟异常时旧 .pyc 可能比新 .py "更新"，
  # Python 会继续加载旧代码，表现就是"代码改了行为没变"
  find backend/app -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
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
