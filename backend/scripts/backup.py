"""数据库备份。

SQLite 的在线备份 API：服务运行中也能用，产物是一个
**完整的、独立的**数据库文件 —— 不需要管 -wal / -shm 那些附属文件。

    python scripts/backup.py                 # 备份到 backups/ 下，带时间戳
    python scripts/backup.py /path/to/x.db   # 指定输出路径

⚠️ 不要直接 cp ladder.db 了事：WAL 模式下数据可能还在 -wal 文件里，
   只复制主文件会拿到一个几乎空的库。用本脚本或先跑一遍 checkpoint。
"""

from __future__ import annotations

import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config import settings  # noqa: E402


def main() -> int:
    url = settings.resolved_database_url
    if not url.startswith("sqlite"):
        print("当前是 PostgreSQL，请用 pg_dump：")
        print("  pg_dump -Fc <连接串> > backup.dump")
        return 1

    src_path = Path(url.split("///", 1)[1])
    if not src_path.exists():
        print(f"数据库不存在：{src_path}")
        return 1

    if len(sys.argv) > 1:
        dst = Path(sys.argv[1]).expanduser().resolve()
    else:
        backup_dir = settings.data_dir / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        dst = backup_dir / f"ladder-{datetime.now().strftime('%Y%m%d-%H%M%S')}.db"

    src = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True)
    dst_conn = sqlite3.connect(str(dst))
    with dst_conn:
        src.backup(dst_conn)  # 在线备份：主文件 + WAL，一个不落
    src.close()
    dst_conn.close()

    size = dst.stat().st_size
    print(f"✓ 已备份到 {dst}（{size / 1024 / 1024:.1f} MB）")

    # 顺手校验一下备份里确实有数据
    check = sqlite3.connect(f"file:{dst}?mode=ro", uri=True)
    counts = []
    for t in ("users", "cards", "courses"):
        try:
            n = check.execute(f"select count(*) from {t}").fetchone()[0]
            counts.append(f"{t}={n}")
        except sqlite3.OperationalError:
            counts.append(f"{t}=?")
    check.close()
    print(f"  内容校验：{' · '.join(counts)}")

    # 只保留最近 30 份，别让备份把磁盘吃满
    backups = sorted(dst.parent.glob("ladder-*.db"))
    for old in backups[:-30]:
        old.unlink()
    return 0


if __name__ == "__main__":
    sys.exit(main())
