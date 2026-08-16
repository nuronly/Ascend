"""端到端冒烟测试：走一遍 v0.1 核心闭环。

    注册 → 建课(真实 LLM 生成大纲) → 懒生成小节正文(SSE)
    → 原文划词建根卡 → AI 回答里划词建子卡(铁律 #1) → 己见 → 收进仓库
    → 番茄钟 → 检索 → 第二大脑 → 跨用户穿透测试

用法：先启动后端，再 `python scripts/smoke.py`
"""

from __future__ import annotations

import json
import sys
import time
import uuid

import httpx

BASE = "http://127.0.0.1:8788/api"
ok_count = 0
fail_count = 0


def check(label: str, cond: bool, detail: str = "") -> bool:
    global ok_count, fail_count
    if cond:
        ok_count += 1
        print(f"  \033[32m✓\033[0m {label}" + (f"  {detail}" if detail else ""))
    else:
        fail_count += 1
        print(f"  \033[31m✗\033[0m {label}  {detail}")
    return cond


def section(title: str) -> None:
    print(f"\n\033[1m{title}\033[0m")


def sse(client: httpx.Client, method: str, url: str, **kw) -> list[tuple[str, dict]]:
    """收集 SSE 事件。"""
    events: list[tuple[str, dict]] = []
    with client.stream(method, url, timeout=300, **kw) as r:
        r.raise_for_status()
        name = "message"
        for line in r.iter_lines():
            if line.startswith("event:"):
                name = line[6:].strip()
            elif line.startswith("data:"):
                try:
                    events.append((name, json.loads(line[5:].strip())))
                except json.JSONDecodeError:
                    pass
    return events


def main() -> int:
    tag = uuid.uuid4().hex[:8]
    a = httpx.Client(base_url=BASE, timeout=300, follow_redirects=True)
    b = httpx.Client(base_url=BASE, timeout=60, follow_redirects=True)

    # ── 1. 鉴权 ──
    section("1. 鉴权 · argon2id + JWT httpOnly cookie")
    r = a.post("/auth/register", json={
        "email": f"alice-{tag}@example.com", "name": "Alice", "password": "test-pass-1234"})
    check("注册成功", r.status_code == 201, f"HTTP {r.status_code} {r.text[:150]}")
    if r.status_code != 201:
        return 1
    check("access token 走 httpOnly cookie", "ladder_at" in a.cookies)
    check("refresh token 走 httpOnly cookie", "ladder_rt" in a.cookies)

    me = a.get("/auth/me")
    check("/auth/me 可读", me.status_code == 200 and me.json()["name"] == "Alice")

    r = b.post("/auth/register", json={
        "email": f"bob-{tag}@example.com", "name": "Bob", "password": "test-pass-1234"})
    check("第二个用户注册（用于穿透测试）", r.status_code == 201)

    r = httpx.get(f"{BASE}/auth/me", timeout=10)
    check("未登录访问被拒", r.status_code == 401)

    # ── 2. 课程：大纲生成 ──
    section("2. 课程线 · 主题 → 大纲（旗舰模型，流式，真实调用）")
    t0 = time.time()
    r = a.post("/courses", json={"topic": "Transformer 注意力机制", "level": "intermediate"})
    if not check("建课立即返回（不阻塞等大纲）", r.status_code == 201 and
                 time.time() - t0 < 3, f"HTTP {r.status_code} {time.time() - t0:.2f}s"):
        return 1
    course_id = r.json()["id"]

    t0 = time.time()
    evs = sse(a, "GET", f"/courses/{course_id}/outline/stream")
    progress = [d["title"] for e, d in evs if e == "progress"]
    check("大纲流式推送进度（等待可见）", len(progress) > 3,
          f"{len(progress)} 次进度 · 首条「{progress[0][:20] if progress else '—'}」")
    check("大纲生成完成", any(e == "done" for e, _ in evs),
          f"{time.time() - t0:.1f}s · " + str([d for e, d in evs if e == "error"])[:150])

    course = a.get(f"/courses/{course_id}").json()
    n_ch = len(course["chapters"])
    n_sec = sum(len(c["sections"]) for c in course["chapters"])
    print(f"     《{course['title']}》 {n_ch} 章 {n_sec} 节 · {time.time() - t0:.1f}s")
    check("章节数在 4~8（PLAN §3.1 约束）", 4 <= n_ch <= 8, f"实际 {n_ch}")
    check("每章 3~6 节", all(3 <= len(c["sections"]) <= 6 for c in course["chapters"]))
    check("小节带 key_concepts（供图谱抽取）", any(
        s["key_concepts"] for c in course["chapters"] for s in c["sections"]))
    check("正文默认未生成（懒生成）", all(
        s["content_status"] == "pending" for c in course["chapters"] for s in c["sections"]))

    section_id = course["chapters"][0]["sections"][0]["id"]

    # ── 3. 番茄钟 ──
    section("3. 番茄钟 · 时间戳制（抗后台节流）")
    r = a.post("/pomodoros", json={"section_id": section_id})
    check("番茄启动", r.status_code == 201, r.text[:150])
    pomo = r.json()
    check("时长取用户默认设置", pomo["planned_minutes"] > 0,
          f"{pomo['planned_minutes']} 分钟")
    check("返回绝对时间戳而非倒计时数字",
          all(k in pomo for k in ("started_at", "expected_end", "server_now")))

    # ── 4. 小节正文流式生成 ──
    section("4. 小节懒生成 · SSE 流式")
    t0 = time.time()
    evs = sse(a, "GET", f"/courses/{course_id}/sections/{section_id}/stream")
    kinds = [e for e, _ in evs]
    deltas = [d["text"] for e, d in evs if e == "delta"]
    body = "".join(deltas)
    check("收到流式 delta", len(deltas) > 5, f"{len(deltas)} 个分片 · {time.time() - t0:.1f}s")
    check("生成完成", "done" in kinds)
    check("正文有实质内容", len(body) > 400, f"{len(body)} 字")
    check("概念块未泄漏到用户可见文本", "LADDER_CONCEPTS" not in body)

    t0 = time.time()
    evs2 = sse(a, "GET", f"/courses/{course_id}/sections/{section_id}/stream")
    check("二次进入命中缓存（不重复烧钱）",
          any(e == "cached" for e, _ in evs2), f"{time.time() - t0:.2f}s")

    r = a.get(f"/graph/concepts?course_id={course_id}")
    check("正文抽取的概念已入概念图", len(r.json()["nodes"]) > 0,
          f"{len(r.json()['nodes'])} 个概念")

    # ── 5. 卡片系统：四条铁律 ──
    section("5. ★ 卡片系统 · §3.2.0 四条不可妥协的交互铁律")

    # 从正文里挑一个真实存在的词做锚点
    import re
    bolds = re.findall(r"\*\*(.+?)\*\*", body)
    picked = next((w for w in bolds if 2 <= len(w) <= 20), "注意力")
    ctx = next((ln for ln in body.split("\n") if picked in ln), picked)[:300]

    r = a.post("/cards", json={
        "selected_text": picked, "context_text": ctx, "question": f"{picked}是什么？",
        "source_type": "course", "source_section_id": section_id,
        "origin": "source_text",
        "text_anchor": {"prefix": ctx[:20], "suffix": ctx[-20:]},
    })
    check("① 原文划词 → 根卡", r.status_code == 201, r.text[:200])
    c1 = r.json()
    check("根卡 parent 为空", c1["parent_card_id"] is None)
    check("自动关联当前番茄", c1["pomodoro_id"] == pomo["id"])
    check("初始状态为 draft", c1["state"] == "draft")

    evs = sse(a, "POST", f"/cards/{c1['id']}/ask", json={"question": f"{picked}是什么？"})
    a1 = "".join(d["text"] for e, d in evs if e == "delta")
    check("卡片流式回答", len(a1) > 80, f"{len(a1)} 字")

    # ★ 铁律 #1：AI 的回答里必须也能划词建卡
    inner = re.findall(r"\*\*(.+?)\*\*", a1)
    sub_word = next((w for w in inner if 2 <= len(w) <= 20 and w != picked), a1[10:16])
    msg_id = next((d["message_id"] for e, d in evs if e == "done"), None)
    at = a1.find(sub_word)

    r = a.post("/cards", json={
        "selected_text": sub_word, "context_text": a1[max(0, at - 60):at + 120],
        "question": f"{sub_word}怎么理解？",
        "parent_card_id": c1["id"], "origin": "parent_answer",
        "origin_message_id": msg_id,
        "origin_offset": {"start": at, "end": at + len(sub_word)},
    })
    check("★铁律1 · AI 回答里划词 → 子卡", r.status_code == 201, r.text[:200])
    c2 = r.json()
    check("子卡 parent 指向父卡", c2["parent_card_id"] == c1["id"])
    check("深度 +1", c2["depth"] == 1)
    check("记录了在哪条回答的哪个偏移划的", c2["origin_message_id"] == msg_id
          and c2["origin_offset"].get("start") == at)

    sse(a, "POST", f"/cards/{c2['id']}/ask", json={"question": f"{sub_word}怎么理解？"})

    # 第三层：己见里划词
    a.patch(f"/cards/{c2['id']}/note",
            json={"user_note": f"我的理解是：{sub_word}的本质在于归一化和权重分配。"})
    r = a.post("/cards", json={
        "selected_text": "归一化", "context_text": "我的理解是：本质在于归一化和权重分配。",
        "question": "归一化具体指什么？",
        "parent_card_id": c2["id"], "origin": "parent_note",
    })
    check("③ 己见里划词 → 子卡", r.status_code == 201)
    c3 = r.json()
    check("三层套娃成链", c3["depth"] == 2, f"深度 {c3['depth']}")
    sse(a, "POST", f"/cards/{c3['id']}/ask", json={"question": "归一化具体指什么？"})

    # ★ 铁律 #2/#3：多卡同屏 + 父子连线
    r = a.get(f"/cards?section_id={section_id}")
    data = r.json()
    check("★铁律2 · 多张卡同时返回（同屏可见）", len(data["cards"]) >= 3,
          f"{len(data['cards'])} 张")
    parented = [c for c in data["cards"] if c["parent_card_id"]]
    check("★铁律3 · 父子关系可连线", len(parented) >= 2, f"{len(parented)} 条父子边")
    check("★铁律4 · 每张卡带画布坐标（浮在旁边而非盖住原文）",
          all("canvas_x" in c and "canvas_y" in c for c in data["cards"]))
    check("卡片带 text_anchor（可回跳原文）", any(c["text_anchor"] for c in data["cards"]))

    # 深度提示
    r = a.post("/cards", json={
        "selected_text": "权重", "question": "权重怎么算？",
        "parent_card_id": c3["id"], "origin": "parent_answer"})
    check("链深 ≥4 触发提权提示（Folium 编号提权）", "depth_hint" in r.json(),
          r.json().get("depth_hint", {}).get("message", "")[:40])

    # ── 6. draft → vault ──
    section("6. 状态机 draft → vault · 写入期做重活")
    a.patch(f"/cards/{c1['id']}/note", json={"user_note": f"用我的话说，{picked}就是一种加权求和。"})
    r = a.post(f"/cards/{c1['id']}/vault")
    check("收进仓库", r.status_code == 200, r.text[:200])
    v = r.json()
    check("状态转为 vault", v["state"] == "vault")
    check("己见卡标记", v["is_rewritten"] is True)
    check("写入期抽取了一句话摘要", bool(v["summary"]), f"「{v['summary'][:40]}」")
    check("写入期抽取了概念标签", len(v["concept_tags"]) > 0, str(v["concept_tags"]))

    a.post(f"/cards/{c2['id']}/vault")
    a.post(f"/cards/{c3['id']}/vault")

    # ── 7. 手动连线 ──
    section("7. 卡片连线 · 只由用户手建")
    r = a.post(f"/cards/{c1['id']}/links",
               json={"to_card_id": c3["id"], "relation": "evidence", "note": "手动建立"})
    check("用户手建 real link", r.status_code == 201 and r.json()["kind"] == "real")
    link_id = r.json()["id"]
    r = a.get(f"/cards/{c1['id']}/links")
    links = r.json()["links"]
    check("焦点卡连线可列出", isinstance(links, list) and len(links) >= 1,
          f"{len(links)} 条")

    # ── 8. 检索与第二大脑 ──
    section("8. 第二大脑 · GraphRAG-lite 多路召回")
    r = a.get(f"/vault/search?q={picked}")
    check("中文全文检索（jieba + FTS5）", len(r.json()["cards"]) > 0,
          f"{len(r.json()['cards'])} 条命中")

    r = a.post("/brain/reindex")
    check("向量索引补齐", r.status_code == 200, f"{r.json()['embedded']} 条")

    evs = sse(a, "POST", "/brain/ask", json={"question": f"我关于{picked}都学过什么？"})
    kinds = [e for e, _ in evs]
    cites = next((d["citations"] for e, d in evs if e == "citations"), [])
    ans = "".join(d["text"] for e, d in evs if e == "delta")
    check("带引用回答", len(cites) > 0, f"{len(cites)} 条引用")
    check("答案可溯源到原始卡片", all("id" in c for c in cites))
    check("生成了回答", len(ans) > 60, f"{len(ans)} 字")

    # ── 9. FSRS ──
    section("9. FSRS 主动复习")
    r = a.get("/review/stats")
    check("排程已建立", r.json()["scheduled"] >= 3, f"{r.json()['scheduled']} 张卡进入排程")
    r = a.post(f"/review/question?card_id={c1['id']}")
    check("生成复习题（非原文复述）", len(r.json()["question"]) > 5,
          f"「{r.json()['question'][:50]}」")
    q = r.json()["question"]
    r = a.post("/review/answer", json={
        "card_id": c1["id"], "question": q, "answer": "它是一种把向量映射为概率分布的加权机制。"})
    check("AI 判分 → 反馈给 FSRS", "rating" in r.json() and "next_due" in r.json(),
          f"评级 {r.json().get('rating')} · 下次 {r.json().get('interval_days')} 天后")

    # ── 10. 番茄结束回顾 ──
    section("10. 番茄结束 · 卡片回顾（而非「休息一下」）")
    r = a.post(f"/pomodoros/{pomo['id']}/finish")
    check("结束返回本颗番茄的待整理卡片", "cards" in r.json(),
          f"{len(r.json()['cards'])} 张待整理")

    # ── 11. 跨用户穿透测试 ──
    section("11. ★ 跨用户穿透测试（PLAN §4.2 / 风险 #12）")
    probes = [
        ("读课程", lambda: b.get(f"/courses/{course_id}")),
        ("读小节", lambda: b.get(f"/courses/{course_id}/sections/{section_id}")),
        ("读卡片", lambda: b.get(f"/cards/{c1['id']}")),
        ("列小节卡片", lambda: b.get(f"/cards?section_id={section_id}")),
        ("改他人卡片己见", lambda: b.patch(f"/cards/{c1['id']}/note", json={"user_note": "x"})),
        ("删他人卡片", lambda: b.delete(f"/cards/{c1['id']}")),
        ("给他人卡片建链", lambda: b.post(f"/cards/{c1['id']}/links",
                                          json={"to_card_id": c3["id"]})),
        ("读他人卡片连线", lambda: b.get(f"/cards/{c1['id']}/links")),
        ("结束他人番茄", lambda: b.post(f"/pomodoros/{pomo['id']}/finish")),
        ("延长他人番茄", lambda: b.post(f"/pomodoros/{pomo['id']}/extend")),
        ("删他人连线", lambda: b.delete(f"/cards/links/{link_id}")),
        ("导出时不含他人数据", lambda: b.get("/export/json")),
        ("读他人概念图", lambda: b.get(f"/graph/concepts?course_id={course_id}")),
        ("叠加视图越权", lambda: b.get(f"/graph/overlay?course_id={course_id}")),
        ("对他人卡片出题", lambda: b.post(f"/review/question?card_id={c1['id']}")),
        ("重生成他人小节", lambda: b.post(f"/cards/{c1['id']}/regenerate")),
        ("改他人小节", lambda: b.patch(f"/courses/{course_id}/sections/{section_id}",
                                       json={"title": "hacked"})),
        ("删他人课程", lambda: b.delete(f"/courses/{course_id}")),
    ]
    leaks = []
    for name, fn in probes:
        try:
            resp = fn()
            code = resp.status_code
        except Exception as exc:
            code, resp = 0, exc
        # 概念图/叠加视图返回空集也算安全
        safe = code in (401, 403, 404)
        if not safe and code == 200 and ("概念图" in name or "叠加" in name):
            safe = len(resp.json().get("nodes", [])) == 0
        if not safe and code == 200 and "导出" in name:
            safe = len(resp.json().get("cards", [])) == 0
        if not safe:
            leaks.append(f"{name}→{code}")
        check(f"B 无法{name}", safe, f"HTTP {code}")

    # B 的检索不能捞到 A 的卡
    r = b.get(f"/vault/search?q={picked}")
    check("B 的检索捞不到 A 的卡（ANN/FTS 隔离）", len(r.json()["cards"]) == 0)
    r = b.get("/cards/meta/stats")
    check("B 的统计不含 A 的数据", r.json()["total"] == 0)

    # ── 12. 数据导出 ──
    section("12. 数据可无损导出（不做数据绑架）")
    r = a.get("/export/json")
    check("JSON 全量导出", r.status_code == 200 and len(r.json()["cards"]) >= 4,
          f"{len(r.json().get('cards', []))} 张卡")
    r = a.get("/export/markdown")
    check("Markdown 打包导出", r.status_code == 200 and len(r.content) > 500,
          f"{len(r.content)} 字节 zip")

    # ── 13. 成本 ──
    section("13. 成本与用量")
    r = a.get("/auth/usage")
    u = r.json()
    check("AI 调用全程记账", u["calls"] > 0,
          f"{u['calls']} 次 · {u['total_tokens']:,} tokens · ${u['cost_usd']:.4f} "
          f"· 缓存命中 {u['cache_hits']} 次")

    r = a.get("/cards/meta/stats")
    s = r.json()
    print(f"\n     卡片总数 {s['total']} · 已沉淀 {s['vaulted']} · 己见率 "
          f"{s['rewrite_rate'] * 100:.0f}% · 最大链深 {s['max_depth']}")

    print(f"\n{'─' * 60}")
    if fail_count == 0:
        print(f"\033[32m全部通过：{ok_count} 项\033[0m")
    else:
        print(f"\033[31m失败 {fail_count} 项\033[0m，通过 {ok_count} 项")
        if leaks:
            print(f"\033[31m⚠️ 越权泄漏：{', '.join(leaks)}\033[0m")
    return 1 if fail_count else 0


if __name__ == "__main__":
    sys.exit(main())
