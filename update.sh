#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════
#  阶梯 · 一键更新（服务器上执行）
#
#      cd /opt/ladder && sudo ./update.sh
#
#  做的事：
#    1. 认出这台机器用的是哪条部署路线（裸机 / 单体 / Docker）
#    2. 处理 git 的 dubious ownership（root 操作非 root 克隆的仓库会被拒）
#    3. git pull（会先暂存服务器上的本地改动，避免冲突中断）
#    4. 只有前端代码变了才重新构建；纯后端改动只重启服务，几秒钟完事
#    5. 按实际监听端口验证服务确实加载了新代码
#
#  ★ 第 1 步是后来补上的，而它恰恰是最要紧的：原来这个脚本无条件调用
#    install.sh，对单体部署（deploy-contest.sh）来说是灾难 —— 一次例行
#    更新就会装上 Nginx、把服务改成只监听 127.0.0.1:8788，而比赛平台只
#    放行了 8000，站点当场失联，偏偏 systemctl 还显示一切正常。
# ═════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
LADDER_ROOT="$ROOT"
# shellcheck source=deploy-lib.sh
. "$ROOT/deploy-lib.sh"

B=$'\033[1m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; D=$'\033[2m'; X=$'\033[0m'
ok()   { printf "${G}✓${X} %s\n" "$1"; }
warn() { printf "${Y}!${X} %s\n" "$1"; }
die()  { printf "${R}✗${X} %s\n" "$1"; exit 1; }
# 精简过的系统镜像里可能没有 timeout，缺了也不该让整个脚本挂掉
run_timeout() {
  if command -v timeout >/dev/null 2>&1; then timeout "$@"; else shift; "$@"; fi
}

# ── 0. 认出部署方式 ──────────────────────────────────────────
# 必须在 pull 之前就确定：连出错提示里该让用户执行哪个脚本，都取决于它。
MODE=$(ladder_mode_detect)
case "$MODE" in
  contest) DEPLOY_SCRIPT=./deploy-contest.sh ;;
  docker)  DEPLOY_SCRIPT=./deploy.sh ;;
  bare)    DEPLOY_SCRIPT=./install.sh ;;
  *)
    MODE=bare
    DEPLOY_SCRIPT=./install.sh
    warn "认不出部署方式（没有 ladder.service，也没有运行中的容器）"
    warn "按「裸机 + Nginx」处理。若这台机器其实是单体部署，请直接跑 ./deploy-contest.sh"
    ;;
esac
ok "部署方式：$(ladder_mode_desc "$MODE")"

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
#
# ★ 只对 github.com 套镜像。ghfast.top 这些只代理 GitHub，原来的 https://*
#   会把自建 GitLab（比赛平台的 synnovator，恰好就是服务器上的 origin）也
#   拼成 https://ghfast.top/https://www.synnovator.com/... —— 必然失败，
#   真到拉不下来那天要白等三次 120 秒超时才给出结论。
UPSTREAM=$(git remote get-url origin 2>/dev/null || echo '')
MIRRORS=("")
case "$UPSTREAM" in
  https://github.com/*) MIRRORS+=("https://ghfast.top/" "https://gh-proxy.com/" "https://ghproxy.net/") ;;
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
  然后在服务器上直接执行 $DEPLOY_SCRIPT"

NEW=$(git rev-parse HEAD)
restore_stash

if [ "$OLD" = "$NEW" ]; then
  ok "已是最新（${NEW:0:7}），无需更新"
else
  ok "已更新 ${OLD:0:7} → ${NEW:0:7}"
  git --no-pager log --oneline "$OLD..$NEW" | sed 's/^/    /'
fi

# ── 决定这次要不要走完整部署 ──────────────────────────────────
FULL=0
if [ "$MODE" = "docker" ]; then
  # 容器把代码烤在镜像里，任何改动都得重建，没有"只重启"这条路
  FULL=1
elif [ "$OLD" != "$NEW" ] && git diff --name-only "$OLD" "$NEW" | grep -q '^frontend/'; then
  # 前端构建要几分钟，后端重启只要几秒 —— 所以只在前端真变了时才全量
  FULL=1
fi

if [ "$FULL" = "1" ]; then
  printf "\n${B}走完整部署：%s${X}\n" "$DEPLOY_SCRIPT"
  exec "$DEPLOY_SCRIPT"
fi

# ★ 走快路径也要把这条路线必须成立的配置对齐一遍。
#   否则新增的强制项（例如 TRUST_PROXY_HEADERS —— 决定限流是真防护还是
#   摆设）要等到下一次全量部署才生效，中间这段时间防护看着是开的、
#   实际没生效，谁都不会发现。
if [ -f backend/.env ] && ladder_apply_mode_env "$MODE" backend/.env "$ROOT"; then
  ok "关键配置已对齐（$(ladder_mode_desc "$MODE")）"
fi

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

# ── 验证 ─────────────────────────────────────────────────────
# 探测地址必须跟着部署方式走。单体模式没有反代，打 80 端口必然失败 ——
# 原来固定探测 http://127.0.0.1 就是这个毛病，永远只能拿到一个 000。
PORT=$(ladder_service_port 2>/dev/null || true)
if [ "$MODE" = "contest" ]; then
  PORT="${PORT:-8000}"
  BASE="http://127.0.0.1:${PORT}"
  HOSTHDR="127.0.0.1:${PORT}"
else
  # 裸机模式走一遍 Nginx，顺带验证反代这一层
  BASE="http://127.0.0.1"
  HOSTHDR=$(grep -E '^SITE_ADDRESS=' backend/.env 2>/dev/null | cut -d= -f2 | tr -d ' ' || true)
  if [ -z "$HOSTHDR" ] || [ "$HOSTHDR" = ":80" ]; then HOSTHDR="127.0.0.1"; fi
fi

printf "\n${B}验证（%s）…${X}\n" "$BASE"

HEALTH=$(curl -fsS -m 10 "${BASE}/api/health" 2>/dev/null || echo '')
case "$HEALTH" in
  *'"status":"ok"'*) ok "健康检查通过  $HEALTH" ;;
  *) warn "健康检查未通过 —— tail -30 backend/logs/server.log" ;;
esac

# 注意：探测时必须让 Host 与 Origin 一致（模拟浏览器的真实同源请求），
# 否则 CSRF 中间件会正确地把它拦下，造成"修复没生效"的误判。
CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 10 -X POST "${BASE}/api/auth/login" \
  -H "Content-Type: application/json" \
  -H "Host: ${HOSTHDR}" \
  -H "Origin: http://${HOSTHDR}" \
  -d '{"email":"probe@example.com","password":"probe-password"}' || echo "000")
case "$CODE" in
  401|200) ok "同源请求正常通过（$CODE）" ;;
  429) warn "被限流挡下（429）—— 说明限流在工作，稍等一分钟再验证" ;;
  403) die "仍返回 403 —— 服务没加载到新代码，把 backend/logs/server.log 末尾发给开发者" ;;
  *) warn "探测返回 $CODE，手动验证：curl ${BASE}/api/health" ;;
esac

printf "\n${G}更新完成${X}\n"
