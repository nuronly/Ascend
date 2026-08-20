"""可续播的生成流（大纲 / 小节正文）。

★ 为什么需要它

  SSE 一断，生成就被 cancel（见 api/sse.py）。可是"生成一节正文要几十秒到
  一分多钟，中途返回课程页看一眼别的东西"是**完全正常的操作** —— 而它的代价是：

    · 已经烧掉的 token 全白费，回来从零重写，用户还得再等一遍
    · content_status 永久停在 generating，正文却没落库
    · 两个标签页同时打开一节 = 各跑一份，互相覆盖

  取消的原意是"别把 token 烧在没人看的响应上"，但这笔账算错了：token 是
  **已经付掉**的，跑完落库才叫止损，半路掐掉才是真浪费。

  所以生成任务不再挂在某一条 HTTP 连接上：

    · 第一个请求启动后台任务；事件既广播给订阅者，也留一份历史
    · 断连只是退订，任务继续跑到落库为止
    · 重新进来的请求先回放历史（立刻看到已经写好的部分），再接着收增量
    · 任务结束后从注册表移除，之后自然走数据库里的缓存

  ★ 后台任务必须用**自己的 session**：请求的 session 在响应结束时就关了，
    拿它写库会炸在 "session is closed" 上 —— 而且是在没人看的后台静默炸掉。

  前提是单进程（本项目就是单 worker 的 systemd 服务）。多 worker 下各进程
  注册表独立，退化成原来的"可能重复生成"，不会比现在更糟。
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Callable

from app.core.db import SessionLocal
from app.core.scope import UserScope

log = logging.getLogger(__name__)

# 工厂拿到的是**后台任务自己的** scope，不是请求那个
Factory = Callable[[UserScope], AsyncIterator[dict]]


def outline_key(course_id: str) -> str:
    return f"outline:{course_id}"


def section_key(section_id: str) -> str:
    return f"section:{section_id}"


class _Run:
    __slots__ = ("key", "history", "subs", "done", "task")

    def __init__(self, key: str, user_id: str, factory: Factory) -> None:
        self.key = key
        self.history: list[dict] = []
        self.subs: set[asyncio.Queue[dict | None]] = set()
        self.done = False
        # 强引用挂在注册表上，不会被 GC 半路收走（裸 create_task 的经典坑）
        self.task = asyncio.create_task(self._pump(user_id, factory), name=f"run:{key}")

    # ── 广播 ──
    def _emit(self, ev: dict) -> None:
        """入历史 + 发给所有订阅者。

        这两步之间没有 await，所以对任何订阅者来说，一个事件要么在它拿到的
        历史快照里，要么从它的队列里来 —— 不会重复，也不会漏。
        """
        self.history.append(ev)
        for q in self.subs:
            q.put_nowait(ev)  # 无界队列：生成绝不能被慢订阅者反压住

    async def _pump(self, user_id: str, factory: Factory) -> None:
        try:
            async with SessionLocal() as session:
                async for ev in factory(UserScope(session, user_id)):
                    self._emit(ev)
        except asyncio.CancelledError:
            raise  # 明确取消（删课 / 强制重生成），不当成错误
        except Exception as exc:
            log.exception("后台生成失败（%s）", self.key)
            self._emit({"event": "error", "data": {"message": str(exc)[:500]}})
        finally:
            self.done = True
            for q in self.subs:
                q.put_nowait(None)
            # 可能已经被 restart 顶替成新的 run，别把别人从注册表里删掉
            if _RUNS.get(self.key) is self:
                del _RUNS[self.key]

    # ── 订阅 ──
    async def subscribe(self) -> AsyncIterator[dict]:
        q: asyncio.Queue[dict | None] = asyncio.Queue()
        self.subs.add(q)
        # 这两行与 add 之间不能有 await，否则历史与队列会重叠或漏事件
        past = list(self.history)
        finished = self.done
        try:
            # 先回放：中途回来的用户立刻看到已经写好的部分，而不是空白重来
            for ev in past:
                yield ev
            if finished:
                return  # 已经收尾了，队列里不会再有 None 来叫醒我们
            while True:
                ev = await q.get()
                if ev is None:
                    break
                yield ev
        finally:
            self.subs.discard(q)


_RUNS: dict[str, _Run] = {}


def stream_run(
    key: str, user_id: str, factory: Factory, *, restart: bool = False
) -> AsyncIterator[dict]:
    """订阅 key 对应的生成流；还没有就启一个后台任务。

    restart=True 用于"重新生成"：先掐掉在跑的那次，否则新旧两份会抢着写同
    一行。
    """
    run = _RUNS.get(key)
    if run is not None and restart:
        cancel_run(key)
        run = None
    if run is None:
        run = _Run(key, user_id, factory)
        _RUNS[key] = run  # 注册要在 pump 真正跑起来之前完成（此处仍是同步段）
        log.info("启动后台生成 %s", key)
    return run.subscribe()


def cancel_run(key: str) -> bool:
    """明确不要这次生成了：删课、或者强制重生成顶掉旧的。

    这是唯一该取消的场合 —— 目标行都要没了，跑完也是写给孤魂野鬼。
    """
    run = _RUNS.pop(key, None)
    if run is None:
        return False
    run.task.cancel()
    for q in run.subs:
        q.put_nowait(None)  # 别让订阅者干等到超时
    log.info("取消后台生成 %s", key)
    return True


def is_running(key: str) -> bool:
    return key in _RUNS


async def shutdown_runs() -> None:
    """进程退出时收尾。

    正在跑的生成注定丢（正文还没落库），至少别留一堆"被取消"的 task 警告，
    也别让 content_status 之外还多出一层不确定。
    """
    for key in list(_RUNS):
        cancel_run(key)
    await asyncio.sleep(0)
