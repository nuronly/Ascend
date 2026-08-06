"""上线自检。

在暴露到公网之前跑一遍，把容易漏的坑挡在门外。

    python scripts/preflight.py            # 检查配置
    python scripts/preflight.py --live URL # 顺带体检一个已上线的实例
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))

from app.core.config import settings  # noqa: E402

ok_n = 0
warn_n = 0
fail_n = 0


def ok(msg: str, detail: str = "") -> None:
    global ok_n
    ok_n += 1
    print(f"  \033[32m✓\033[0m {msg}" + (f"  \033[2m{detail}\033[0m" if detail else ""))


def warn(msg: str, detail: str = "") -> None:
    global warn_n
    warn_n += 1
    print(f"  \033[33m!\033[0m {msg}" + (f"  \033[2m{detail}\033[0m" if detail else ""))


def fail(msg: str, detail: str = "") -> None:
    global fail_n
    fail_n += 1
    print(f"  \033[31m✗\033[0m {msg}" + (f"  \033[2m{detail}\033[0m" if detail else ""))


def section(t: str) -> None:
    print(f"\n\033[1m{t}\033[0m")


def check_config() -> None:
    section("1. 鉴权")
    s = settings.jwt_secret
    if s in ("", "dev-only-secret-please-change-me"):
        fail("JWT_SECRET 是默认值", "任何人都能伪造登录态：openssl rand -base64 48")
    elif len(s) < 32:
        fail("JWT_SECRET 过短", f"{len(s)} 字符，建议 ≥ 43")
    else:
        ok("JWT_SECRET 已设置", f"{len(s)} 字符")

    # cookie_secure 的对错取决于站点到底跑没跑 HTTPS，不能一律要求 true。
    # 明文 HTTP 下设成 true，浏览器根本不回传 cookie —— 表现为「登录成功后
    # 立刻被踢回登录页」，比不加密更致命。所以这里按 PUBLIC_URL 分情况判。
    _https = (settings.public_url or "").startswith("https://")
    if settings.cookie_secure and not _https:
        fail(
            "COOKIE_SECURE=true 但站点不是 HTTPS",
            "浏览器不会回传 Secure cookie，登录会直接失效。配好证书或先改回 false",
        )
    elif _https and not settings.cookie_secure:
        fail("COOKIE_SECURE=false 但站点是 HTTPS", "cookie 明文传输，登录态可被劫持")
    elif not _https:
        warn(
            "站点是明文 HTTP",
            "登录态无法加密传输。配好 HTTPS 后，记得把 COOKIE_SECURE 一并改为 true",
        )
    else:
        ok("COOKIE_SECURE=true", "与 HTTPS 匹配")

    if settings.access_token_minutes > 60:
        warn(f"access token 有效期 {settings.access_token_minutes} 分钟", "偏长")
    else:
        ok(f"access token {settings.access_token_minutes} 分钟 / refresh {settings.refresh_token_days} 天")

    section("2. 成本防护（公开上线最大的风险）")
    if settings.allow_registration and not settings.invite_code and not settings.max_users:
        fail(
            "注册完全开放且无任何限制",
            "别人注册就烧你的额度。设 INVITE_CODE 或 MAX_USERS，或关闭注册",
        )
    else:
        bits = []
        if not settings.allow_registration:
            bits.append("已关闭注册")
        if settings.invite_code:
            bits.append("需邀请码")
        if settings.max_users:
            bits.append(f"上限 {settings.max_users} 人")
        ok("准入受控", " · ".join(bits))

    if settings.guest_enabled:
        # 游客共享一个账号、共烧一份额度。演示场景是特性，长期开放是风险
        if settings.guest_daily_token_quota > settings.daily_token_quota:
            warn(
                f"游客额度 {settings.guest_daily_token_quota:,} 高于正式用户",
                "所有人共烧这一份，建议调低 GUEST_DAILY_TOKEN_QUOTA",
            )
        else:
            ok("游客模式已开启", f"共享额度 {settings.guest_daily_token_quota:,} tokens/天")

    if settings.daily_token_quota <= 0:
        fail("DAILY_TOKEN_QUOTA=0（不限额）", "单个用户就能刷爆账单")
    elif settings.daily_token_quota > 2_000_000:
        warn(f"每日额度 {settings.daily_token_quota:,}", "偏高，按当前定价约 $2~4/人/天")
    else:
        ok(f"每日额度 {settings.daily_token_quota:,} tokens/人")

    if settings.rate_limit_enabled:
        ok(
            "速率限制已开启",
            f"认证 {settings.rate_auth_per_minute}/min · AI {settings.rate_ai_per_minute}/min",
        )
    else:
        fail("速率限制未开启", "RATE_LIMIT_ENABLED=true")

    section("3. LLM")
    from app.llm.registry import available_providers

    providers = available_providers()
    if not providers:
        fail("没有可用的 LLM Provider", "AI 功能全部不可用")
    else:
        ok(f"Provider: {', '.join(providers)}")
        if len(providers) == 1:
            warn("只有一个 Provider", "降级链无法跨供应商，单点故障时全站 AI 不可用")
        else:
            ok("降级链可跨供应商", " → ".join(settings.fallback_list) or "未配置")

    for label, spec in (
        ("旗舰", settings.model_flagship),
        ("中档", settings.model_standard),
        ("小模型", settings.model_small),
        ("向量", settings.model_embedding),
    ):
        print(f"      {label:<6} {spec}")

    section("4. 数据")
    if settings.is_sqlite:
        # 显示解析后的绝对路径。写相对路径本身没问题（settings 会锚定到 backend/），
        # 但只把 "./data/ladder.db" 打出来，没人知道文件实际落在哪
        path = settings.resolved_database_url.split("///")[-1]
        ok("SQLite", f"{path} —— 单 worker 可用；多 worker 请切 PostgreSQL")
        db = Path(path)
        if db.exists():
            size = db.stat().st_size
            wal = db.with_name(db.name + "-wal")
            wal_size = wal.stat().st_size if wal.exists() else 0
            ok("数据文件存在", f"主库 {size / 1024:.0f} KB · WAL {wal_size / 1024:.0f} KB")
            # WAL 远大于主库 = 长时间没 checkpoint，主库其实是个空壳，
            # 只备份 .db 会丢掉几乎所有数据
            if wal_size > max(size, 65536) * 2:
                warn(
                    "WAL 明显大于主库",
                    "数据大都还在 -wal 里；备份务必带上 -wal/-shm，或先执行 checkpoint",
                )
        else:
            warn("数据文件尚未创建", "首次启动后才会生成")
    else:
        ok("PostgreSQL", "支持多 worker")

    section("5. 前端")
    if settings.serve_frontend:
        if settings.dist_path:
            ok("静态前端已就绪", str(settings.dist_path))
        else:
            fail("SERVE_FRONTEND=true 但找不到 dist", "先执行 npm run build")
    else:
        warn("未启用内置静态服务", "前端需由 Caddy/Nginx 单独提供")

    if settings.is_prod:
        for origin in settings.cors_origin_list:
            if origin.startswith("http://") and "localhost" not in origin:
                fail(f"CORS 含明文 http 来源：{origin}")
        if settings.public_url and not settings.public_url.startswith("https://"):
            warn("PUBLIC_URL 不是 https")


async def check_live(base: str) -> None:
    import httpx

    section(f"6. 线上实例体检 · {base}")
    base = base.rstrip("/")
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as c:
        try:
            r = await c.get(f"{base}/api/health")
            if r.status_code == 200:
                ok("健康检查", str(r.json()))
            else:
                fail(f"健康检查返回 {r.status_code}")
                return
        except Exception as exc:
            fail("无法连接", str(exc)[:120])
            return

        if base.startswith("https://"):
            ok("使用 HTTPS")
            h = r.headers
            for name, why in (
                ("strict-transport-security", "HSTS"),
                ("x-content-type-options", "防 MIME 嗅探"),
                ("x-frame-options", "防点击劫持"),
                ("content-security-policy", "CSP —— LLM 内容 XSS 的第二道防线"),
            ):
                if name in h:
                    ok(f"响应头 {why}")
                else:
                    warn(f"缺少响应头 {name}", why)
        else:
            fail("未使用 HTTPS", "cookie 会明文传输")

        r = await c.get(f"{base}/api/docs")
        if r.status_code == 404:
            ok("API 文档已在生产关闭")
        else:
            warn("API 文档可公开访问", "APP_ENV=prod 会自动关闭")

        r = await c.get(f"{base}/api/auth/me")
        if r.status_code == 401:
            ok("未登录访问被拒绝")
        else:
            fail(f"未登录竟返回 {r.status_code}")

        r = await c.get(f"{base}/api/auth/config")
        if r.status_code == 200:
            cfg = r.json()
            if cfg.get("allow_registration") and not cfg.get("invite_required"):
                warn("线上仍开放自由注册", "确认这是你想要的")
            else:
                ok("线上注册受控", str(cfg))

        r = await c.get(f"{base}/")
        if r.status_code == 200 and "<!doctype html" in r.text[:200].lower():
            ok("前端可访问")
        else:
            warn(f"首页返回 {r.status_code}")


def main() -> int:
    print("\n\033[1m阶梯 · 上线自检\033[0m")
    print(f"环境：{settings.app_env}")
    check_config()

    if "--live" in sys.argv:
        i = sys.argv.index("--live")
        if i + 1 < len(sys.argv):
            import asyncio

            asyncio.run(check_live(sys.argv[i + 1]))

    print("\n" + "─" * 62)
    print(f"通过 {ok_n} · 警告 {warn_n} · \033[31m失败 {fail_n}\033[0m")
    if fail_n:
        print("\033[31m有阻断性问题，修完再上线。\033[0m")
    elif warn_n:
        print("\033[33m可以上线，但请确认上面的警告是有意为之。\033[0m")
    else:
        print("\033[32m全部通过，可以上线。\033[0m")
    return 1 if fail_n else 0


if __name__ == "__main__":
    sys.exit(main())
