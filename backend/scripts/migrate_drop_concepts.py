"""迁移：移除概念图，清空旧课程。

为什么要连课程一起删：老课程的 sections.prerequisite_ids 里存的是模型当时
给的临时编号（"1.1" 这种），而那个编号从来没有落库 —— 映射不回真实小节，
学习路径图会画成一堆没有任何连线的散点。与其展示一张假图，不如让用户重建
（重建一门课就是一次旗舰模型调用，几分钟的事）。

卡片不受影响：cards.source_section_id 是 ON DELETE SET NULL，
卡片继续留在仓库里，只是不再指向某一节。

    python scripts/migrate_drop_concepts.py --dry-run   # 只看会动什么
    python scripts/migrate_drop_concepts.py --yes       # 真的执行
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import text  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.db import engine  # noqa: E402

# DROP 顺序有讲究：先删外键指向别人的，再删被指向的
DROP_TABLES = ("card_concepts", "concept_edges", "concepts")
INSPECT = (*DROP_TABLES, "courses", "chapters", "sections", "cards")


async def _count(conn, table: str) -> int | None:
    """表不存在时返回 None，而不是抛错 —— 迁移可能被重复执行。"""
    try:
        return await conn.scalar(text(f"SELECT count(*) FROM {table}"))  # noqa: S608
    except Exception:
        return None


async def main() -> int:
    dry = "--dry-run" in sys.argv
    if not dry and "--yes" not in sys.argv:
        print(__doc__)
        print("⚠️  这是破坏性操作。确认后加 --yes 执行，或先用 --dry-run 预览。")
        return 1

    print(f"库：{settings.resolved_database_url}\n")

    async with engine.begin() as conn:
        counts = {t: await _count(conn, t) for t in INSPECT}
        for t, n in counts.items():
            print(f"  {t:16} {'（无此表）' if n is None else f'{n} 行'}")

        if dry:
            print("\n--dry-run：什么都没有改。")
            return 0

        # 1. 清空课程。章、节由外键级联删除；卡片的 source_section_id 置空
        if counts.get("courses"):
            await conn.execute(text("DELETE FROM courses"))
            print(f"\n✓ 已删除 {counts['courses']} 门课程（章节级联，卡片保留）")

        # 2. DROP 概念图三张表
        for t in DROP_TABLES:
            if counts.get(t) is not None:
                await conn.execute(text(f"DROP TABLE IF EXISTS {t}"))
                print(f"✓ 已删除表 {t}")

        left = {t: await _count(conn, t) for t in INSPECT}

    print("\n迁移后：")
    for t, n in left.items():
        print(f"  {t:16} {'（已移除）' if n is None else f'{n} 行'}")
    print("\n完成。重启服务后建一门新课即可看到学习路径图。")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
