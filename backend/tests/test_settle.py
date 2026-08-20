"""沉淀链路：一张卡（或一份笔记）怎么才算真的进了系统。

★ 这组测试来自一次静默故障

  沉淀是四件事：摘要 / 全文索引 / 向量 / FSRS 排程。它们原来分散在两处
  （to_vault 与 stream_answer），把「收进仓库」自动化时只搬走了前两件 ——
  后果是**向量召回与复习队列对所有新卡永远为空**：查询不报错，只是永远
  查不出东西，没有任何日志会提醒你。

  所以现在只有一个入口 settle_card，并用测试钉住「四件事都做了」。
  哪天有人再往里加一环、或者又开出第二个入口，这里会红。

没装 pytest 也能跑：python tests/test_settle.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from app.core.types import utcnow  # noqa: E402
from app.models.card import KIND_CARD, STATE_VAULT, Card  # noqa: E402
from app.services import card as svc  # noqa: E402


def _card(**kw) -> Card:
    base = dict(
        id="c1",
        user_id="u1",
        kind=KIND_CARD,
        state=STATE_VAULT,
        question="为什么要除以根号 d？",
        ai_answer="因为点积方差随维度增长",
        user_note="",
        selected_text="softmax",
        summary="",
        is_rewritten=False,
        enriched_at=None,
        created_at=utcnow(),
    )
    base.update(kw)
    return Card(**base)  # type: ignore[arg-type]


class FakeScope:
    def __init__(self) -> None:
        self.user_id = "u1"
        self.commits = 0

    async def commit(self) -> None:
        self.commits += 1


class Recorder:
    """把四个沉淀环节全换成探针，只看谁被调用了。"""

    def __init__(self, *, fail: str = "") -> None:
        self.calls: list[str] = []
        self.fail = fail

    def install(self):
        import app.services.brain as brain
        import app.services.review as review

        self._real = (svc.enrich_card, svc.index_card, brain.embed_card, review.ensure_review_state)

        def make(name: str):
            async def fn(*_a, **_kw):
                self.calls.append(name)
                if self.fail == name:
                    raise RuntimeError(f"{name} 挂了")

            return fn

        svc.enrich_card = make("enrich")  # type: ignore[assignment]
        svc.index_card = make("index")  # type: ignore[assignment]
        brain.embed_card = make("embed")  # type: ignore[assignment]
        review.ensure_review_state = make("review")  # type: ignore[assignment]

    def restore(self):
        import app.services.brain as brain
        import app.services.review as review

        svc.enrich_card, svc.index_card, brain.embed_card, review.ensure_review_state = self._real


def _settle(card: Card, *, fail: str = "", re_enrich: bool = False) -> list[str]:
    rec = Recorder(fail=fail)
    rec.install()
    try:
        asyncio.run(
            svc.settle_card(FakeScope(), card, re_enrich=re_enrich)  # type: ignore[arg-type]
        )
    finally:
        rec.restore()
    return rec.calls


# ─────────────────────────────────────────────────────────────
class Test四件事一件都不能少:
    def test_首次沉淀做全四件(self):
        """少任何一件都会静默丢掉一路能力 —— 向量召回或复习推送。"""
        assert _settle(_card()) == ["enrich", "index", "embed", "review"]

    def test_已经抽过摘要就不再重抽(self):
        """追问每轮都重抽摘要是白花钱；全文索引用的是正文，不受影响。"""
        calls = _settle(_card(enriched_at=utcnow()))
        assert calls == ["index", "embed", "review"]

    def test_用户改过内容时强制重抽摘要(self):
        calls = _settle(_card(enriched_at=utcnow()), re_enrich=True)
        assert calls[0] == "enrich"

    def test_任一环失败不影响其余环(self):
        """卡和回答早就落库了，沉淀是增强 —— 不该反过来毁掉主流程。"""
        for broken in ("index", "embed", "review"):
            calls = _settle(_card(), fail=broken)
            assert broken in calls, broken
            # 断在中间也要继续往后跑
            assert len(calls) == 4, f"{broken} 挂掉后没跑完：{calls}"


class Test只有一个入口:
    def test_to_vault_走的也是_settle_card(self):
        """两个入口就一定会漂移 —— 上次就是这么漏掉向量与排程的。"""
        seen: list[str] = []

        async def spy(*_a, **kw):
            seen.append("settle")
            assert kw.get("re_enrich") is True  # 用户认过的内容要重抽摘要

        real = svc.settle_card
        svc.settle_card = spy  # type: ignore[assignment]
        try:
            card = _card(state="draft", user_note="我自己的理解")
            asyncio.run(svc.to_vault(FakeScope(), card))  # type: ignore[arg-type]
        finally:
            svc.settle_card = real  # type: ignore[assignment]

        assert seen == ["settle"]
        assert card.state == STATE_VAULT
        assert card.is_rewritten is True  # 写过我的话 → 属性如实反映
        assert card.vaulted_at is not None

    def test_答完一轮就沉淀_源码里必须调_settle_card(self):
        """stream_answer 尾部曾经只调了 enrich+index，漏掉后两件。"""
        src = (_BACKEND / "app" / "services" / "card.py").read_text()
        body = src.split("async def stream_answer")[1].split("async def settle_card")[0]
        assert "settle_card(" in body
        # 不该再出现「只搬两件」的写法
        assert "await enrich_card(scope, card, quota=quota)\n        await index_card" not in body


# ─────────────────────────────────────────────────────────────
def _独立运行() -> int:
    ok = failed = 0
    for cls in (Test四件事一件都不能少, Test只有一个入口):
        inst = cls()
        for name in sorted(n for n in dir(inst) if n.startswith("test_")):
            try:
                getattr(inst, name)()
                ok += 1
            except Exception as exc:  # noqa: BLE001
                failed += 1
                print(f"  ✗ {cls.__name__}.{name}: {exc!r}")
    print(f"通过 {ok} · 失败 {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_独立运行())
