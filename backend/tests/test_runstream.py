"""可续播的生成流。

用户在小节正文生成到一半时返回课程页 —— 完全正常的操作 —— 结果回来发现
正文从零重写，前面烧掉的 token 全白费。这一层就是为了这件事：

  · 断连只是退订，生成继续跑到落库
  · 重进先回放历史（立刻看到已经写好的部分），再接着收增量
  · 同一节的并发订阅只跑一次，不会两份互相覆盖
  · 只有"目标行都要没了"（删课 / 强制重生成）才真的取消

事件既不能重复也不能丢：正文是靠 delta 累加出来的，重一段就多一段乱码，
漏一段就缺一块。

没装 pytest 也能跑：python tests/test_runstream.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from app.services import runstream  # noqa: E402
from app.services.runstream import cancel_run, is_running, stream_run  # noqa: E402


# ─────────────────────────────────────────────────────────────
# 测试替身：不碰真数据库
# ─────────────────────────────────────────────────────────────
class _FakeSessionCtx:
    async def __aenter__(self):
        return object()

    async def __aexit__(self, *_exc):
        return False


def _patch_session() -> None:
    runstream.SessionLocal = lambda: _FakeSessionCtx()  # type: ignore[assignment]


class Recorder:
    """记录工厂被调用几次、总共产出了哪些事件、有没有跑到最后。"""

    def __init__(self, n: int = 5, *, boom: bool = False) -> None:
        self.n = n
        self.boom = boom
        self.calls = 0
        self.emitted: list[str] = []
        self.finished = False

    def factory(self, _scope):
        self.calls += 1

        async def gen():
            try:
                for i in range(self.n):
                    await asyncio.sleep(0)  # 让出调度，模拟真实的分片产出
                    if self.boom and i == 2:
                        raise RuntimeError("模型炸了")
                    self.emitted.append(f"e{i}")
                    yield {"event": "delta", "data": {"text": f"e{i}"}}
                self.finished = True
            finally:
                pass

        return gen()


async def _drain(key: str, rec: Recorder, *, take: int | None = None) -> list[dict]:
    """订阅并收事件；take 到了就提前退订（= 用户切走）。"""
    out: list[dict] = []
    agen = stream_run(key, "u1", rec.factory)
    try:
        async for ev in agen:
            out.append(ev)
            if take is not None and len(out) >= take:
                break
    finally:
        await agen.aclose()  # type: ignore[attr-defined]
    return out


def _text(events: list[dict]) -> str:
    return "".join(e["data"]["text"] for e in events if e["event"] == "delta")


# ─────────────────────────────────────────────────────────────
class Test续播:
    def test_断连后生成继续跑完(self):
        """核心诉求：切走不等于放弃，token 已经付了就得跑到落库。"""

        async def run():
            _patch_session()
            rec = Recorder(n=5)
            got = await _drain("section:a", rec, take=2)
            assert len(got) == 2
            assert not rec.finished  # 这会儿确实还没跑完
            # 退订后任务仍在，跑到自然结束
            task = runstream._RUNS["section:a"].task
            await task
            assert rec.finished
            assert rec.emitted == ["e0", "e1", "e2", "e3", "e4"]

        asyncio.run(run())

    def test_重新进来能拿到完整正文(self):
        """回放历史 + 接着收增量，拼起来必须是全文，一段不重一段不漏。"""

        async def run():
            _patch_session()
            rec = Recorder(n=6)
            first = await _drain("section:b", rec, take=2)
            second = await _drain("section:b", rec)  # 中途重进
            assert rec.calls == 1  # 没有重跑，也就没有二次付费
            assert _text(second) == "e0e1e2e3e4e5"
            assert _text(first) == "e0e1"

        asyncio.run(run())

    def test_并发订阅只生成一次且两边都完整(self):
        """两个标签页打开同一节：跑一份，各看各的，不能互相覆盖。"""

        async def run():
            _patch_session()
            rec = Recorder(n=5)
            a, b = await asyncio.gather(_drain("section:c", rec), _drain("section:c", rec))
            assert rec.calls == 1
            assert _text(a) == "e0e1e2e3e4"
            assert _text(b) == "e0e1e2e3e4"

        asyncio.run(run())

    def test_跑完就从注册表移除(self):
        """留着就是内存泄漏，而且之后该走数据库缓存了。"""

        async def run():
            _patch_session()
            rec = Recorder(n=3)
            await _drain("section:d", rec)
            assert not is_running("section:d")

        asyncio.run(run())

    def test_重生成顶掉在跑的那次(self):
        """否则新旧两份会抢着写同一行正文。"""

        async def run():
            _patch_session()
            old = Recorder(n=50)
            agen = stream_run("section:e", "u1", old.factory)
            await agen.__anext__()  # type: ignore[attr-defined]
            old_task = runstream._RUNS["section:e"].task

            new = Recorder(n=3)
            fresh = stream_run("section:e", "u1", new.factory, restart=True)
            got = [ev async for ev in fresh]

            assert old_task.cancelled() or old_task.done()
            assert not old.finished  # 旧的被真的掐掉了
            assert _text(got) == "e0e1e2"
            await agen.aclose()  # type: ignore[attr-defined]

        asyncio.run(run())

    def test_取消会叫醒订阅者(self):
        """删课时不能让还挂着的连接干等到心跳超时。"""

        async def run():
            _patch_session()
            rec = Recorder(n=100)
            agen = stream_run("section:f", "u1", rec.factory)
            await agen.__anext__()  # type: ignore[attr-defined]

            async def consume():
                return [ev async for ev in agen]

            task = asyncio.create_task(consume())
            await asyncio.sleep(0)
            assert cancel_run("section:f") is True
            rest = await asyncio.wait_for(task, timeout=1)
            assert not rec.finished
            assert not is_running("section:f")
            assert isinstance(rest, list)

        asyncio.run(run())

    def test_生成失败要把错误发给订阅者(self):
        """静默死掉最糟：前端会一直转圈到心跳超时。"""

        async def run():
            _patch_session()
            rec = Recorder(n=5, boom=True)
            got = await _drain("section:g", rec)
            assert got[-1]["event"] == "error"
            assert "模型炸了" in got[-1]["data"]["message"]
            assert not is_running("section:g")  # 失败也要清理

        asyncio.run(run())

    def test_已经结束的流_重新订阅只拿到历史且不卡住(self):
        """任务收尾后队列里不会再有唤醒信号，订阅必须靠 done 快照自己收工。"""

        async def run():
            _patch_session()
            rec = Recorder(n=3)
            key = "section:h"
            agen = stream_run(key, "u1", rec.factory)
            await agen.__anext__()  # type: ignore[attr-defined]
            run_obj = runstream._RUNS[key]
            await run_obj.task  # 先让它跑完
            # 此时注册表已清空，但拿着旧 run 对象订阅不能死等
            got = await asyncio.wait_for(
                _collect(run_obj.subscribe()), timeout=1
            )
            assert _text(got) == "e0e1e2"
            await agen.aclose()  # type: ignore[attr-defined]

        asyncio.run(run())


async def _collect(agen) -> list[dict]:
    return [ev async for ev in agen]


# ─────────────────────────────────────────────────────────────
def _独立运行() -> int:
    inst = Test续播()
    failed = 0
    for name in sorted(n for n in dir(inst) if n.startswith("test_")):
        runstream._RUNS.clear()
        try:
            getattr(inst, name)()
            print(f"  ✓ {name}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"  ✗ {name}: {exc!r}")
    print("全部通过" if not failed else f"{failed} 项失败")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_独立运行())
