"""文档模式服务（PLAN §3.5）。

两条硬要求：
  1. **按段落文本 hash 缓存翻译** —— 同一篇翻两次不能重复烧钱
  2. **arXiv 走 HTML 版** —— 比解析 PDF 效果好一个量级，优先走这条
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import AsyncIterator

import httpx
from sqlalchemy import func, select

from app.core.config import TIER_SMALL
from app.core.scope import UserScope
from app.core.types import new_id, utcnow
from app.llm import Message, chat
from app.models.document import DOC_FAILED, DOC_PARSING, DOC_READY, DocBlock, Document
from app.services import docparse

log = logging.getLogger(__name__)

ARXIV_RE = re.compile(
    r"arxiv\.org/(?:abs|pdf|html)/(\d{4}\.\d{4,5}(?:v\d+)?)|^(\d{4}\.\d{4,5}(?:v\d+)?)$",
    re.I,
)

TRANSLATE_SYSTEM = """你是技术文献翻译。把给定段落译成简体中文。

铁律：
- 专业术语首次出现用「中文（English）」双写，之后只用中文
- 数学公式、变量名、代码、文件名、URL 一律保持原样不译
- 保持原有的语气与信息密度，不增删内容，不加解释
- 人名、机构名、论文标题保留原文
- 只输出译文本身，不要任何前缀、说明或引号包裹
- 如果这段本来就是中文，原样返回"""


def detect_arxiv(text: str) -> str | None:
    m = ARXIV_RE.search(text.strip())
    if not m:
        return None
    return m.group(1) or m.group(2)


async def fetch_arxiv(arxiv_id: str) -> tuple[str, list[docparse.Block], int]:
    """抓 arXiv 论文。

    优先 HTML 版（arxiv.org/html 或 ar5iv），失败才退回 PDF ——
    PDF 双栏切段的稀碎程度是另一个量级（PLAN §7 风险 #5）。
    """
    urls = [
        f"https://arxiv.org/html/{arxiv_id}",
        f"https://ar5iv.labs.arxiv.org/html/{arxiv_id}",
    ]
    async with httpx.AsyncClient(
        timeout=60.0, follow_redirects=True, headers={"User-Agent": "Ladder/0.1 (learning tool)"}
    ) as client:
        for url in urls:
            try:
                r = await client.get(url)
                if r.status_code == 200 and len(r.text) > 4000:
                    blocks, _ = docparse.parse_html(r.text)
                    if len(blocks) >= 5:
                        title = docparse.title_from_html(r.text) or f"arXiv:{arxiv_id}"
                        log.info("arXiv %s 走 HTML 版，%s 段", arxiv_id, len(blocks))
                        return title, blocks, 1
            except Exception as exc:
                log.warning("抓取 %s 失败：%s", url, exc)

        # 兜底：PDF
        try:
            r = await client.get(f"https://arxiv.org/pdf/{arxiv_id}")
            r.raise_for_status()
            blocks, pages = docparse.parse_pdf(r.content)
            log.info("arXiv %s 退回 PDF，%s 段", arxiv_id, len(blocks))
            return f"arXiv:{arxiv_id}", blocks, pages
        except Exception as exc:
            raise ValueError(f"无法获取 arXiv:{arxiv_id} —— {exc}") from exc


async def store_blocks(scope: UserScope, doc: Document, blocks: list[docparse.Block]) -> int:
    """落库，并复用已有译文。

    ★ 翻译缓存的关键：按 text_hash 全局查一次，
      同一段文字（哪怕来自另一篇文档）只翻译一次。
    """
    if not blocks:
        return 0

    hashes = list({b.hash for b in blocks})
    cached: dict[str, str] = {}
    # SQLite 的参数上限是 999，分批查
    for i in range(0, len(hashes), 400):
        rows = await scope.session.execute(
            select(DocBlock.text_hash, DocBlock.translation)
            .join(Document, Document.id == DocBlock.doc_id)
            .where(
                Document.user_id == scope.user_id,
                DocBlock.text_hash.in_(hashes[i : i + 400]),
                DocBlock.translation.is_not(None),
            )
        )
        for h, tr in rows:
            cached.setdefault(h, tr)

    for idx, b in enumerate(blocks):
        h = b.hash
        scope.add(
            DocBlock(
                id=new_id(),
                doc_id=doc.id,
                page=b.page,
                idx=idx,
                block_type=b.block_type,
                text=b.text,
                bbox=b.bbox,
                text_hash=h,
                translation=cached.get(h),
                translated_at=utcnow() if h in cached else None,
            )
        )
    await scope.commit()
    if cached:
        log.info("命中翻译缓存 %s 段", len(cached))
    return len(blocks)


async def import_upload(
    scope: UserScope, *, filename: str, data: bytes, mime: str
) -> Document:
    doc = Document(
        id=new_id(),
        user_id=scope.user_id,
        filename=filename[:500],
        title=filename.rsplit(".", 1)[0][:500],
        mime=mime[:120],
        origin="upload",
        parse_status=DOC_PARSING,
    )
    scope.add(doc)
    await scope.commit()

    try:
        blocks, pages = await asyncio.to_thread(docparse.parse, data, filename, mime)
        if not blocks:
            raise ValueError("没有解析出任何文本 —— 可能是扫描件（图片型 PDF），暂不支持 OCR")
        doc.page_count = pages
        await store_blocks(scope, doc, blocks)
        doc.parse_status = DOC_READY
        doc.error = None
    except Exception as exc:
        doc.parse_status = DOC_FAILED
        doc.error = str(exc)[:1000]
        log.exception("文档解析失败")
    await scope.commit()
    return doc


async def import_url(scope: UserScope, url: str) -> Document:
    arxiv_id = detect_arxiv(url)
    doc = Document(
        id=new_id(),
        user_id=scope.user_id,
        filename=f"arXiv-{arxiv_id}" if arxiv_id else url[:200],
        title=f"arXiv:{arxiv_id}" if arxiv_id else url[:200],
        mime="text/html",
        origin="arxiv" if arxiv_id else "url",
        source_url=url,
        parse_status=DOC_PARSING,
    )
    scope.add(doc)
    await scope.commit()

    try:
        if arxiv_id:
            title, blocks, pages = await fetch_arxiv(arxiv_id)
            doc.title = title[:500]
            doc.meta = {"arxiv_id": arxiv_id}
        else:
            async with httpx.AsyncClient(
                timeout=60.0, follow_redirects=True, headers={"User-Agent": "Ladder/0.1"}
            ) as client:
                r = await client.get(url)
                r.raise_for_status()
            blocks, pages = docparse.parse_html(r.text)
            doc.title = (docparse.title_from_html(r.text) or url)[:500]
        if not blocks:
            raise ValueError("这个页面没有可提取的正文")
        doc.page_count = pages
        await store_blocks(scope, doc, blocks)
        doc.parse_status = DOC_READY
        doc.error = None
    except Exception as exc:
        doc.parse_status = DOC_FAILED
        doc.error = str(exc)[:1000]
        log.exception("URL 导入失败")
    await scope.commit()
    return doc


# ─────────────────────────────────────────────────────────────
# 翻译
# ─────────────────────────────────────────────────────────────
_SKIP_TYPES = {"code"}
_CJK = re.compile(r"[\u4e00-\u9fff]")


def _needs_translation(b: DocBlock) -> bool:
    if b.translation is not None or b.block_type in _SKIP_TYPES:
        return False
    t = b.text.strip()
    if len(t) < 3:
        return False
    # 已经是中文的不翻。阈值取 30%：中英混排的技术文本仍会被翻
    cjk = len(_CJK.findall(t))
    return cjk / max(len(t), 1) < 0.3


async def translate_block(
    scope: UserScope, block: DocBlock, *, quota: int | None = None
) -> str | None:
    result = await chat(
        [
            Message(role="system", content=TRANSLATE_SYSTEM),
            Message(role="user", content=block.text),
        ],
        scene="translate",
        tier=TIER_SMALL,  # 量大，单价必须压住
        user_id=scope.user_id,
        temperature=0.2,
        max_tokens=2400,
        use_cache=True,  # ★ 按内容 hash 缓存，同一段永不重复付费
        quota=quota,
    )
    return (result.text or "").strip() or None


async def stream_translate(
    scope: UserScope, doc_id: str, *, concurrency: int = 4, quota: int | None = None
) -> AsyncIterator[dict]:
    """整篇翻译，SSE 汇报进度。

    并发 + hash 缓存 + 单段失败不影响整体（PLAN §3.5）。
    """
    doc = await scope.require(Document, doc_id, "文档")
    blocks = await scope.all(
        select(DocBlock).where(DocBlock.doc_id == doc.id).order_by(DocBlock.page, DocBlock.idx)
    )
    todo = [b for b in blocks if _needs_translation(b)]

    yield {
        "event": "start",
        "data": {"total": len(blocks), "todo": len(todo), "cached": len(blocks) - len(todo)},
    }
    if not todo:
        yield {"event": "done", "data": {"translated": 0, "failed": 0}}
        return

    sem = asyncio.Semaphore(concurrency)
    done = 0
    failed = 0
    lock = asyncio.Lock()
    queue: asyncio.Queue[dict] = asyncio.Queue()

    async def work(b: DocBlock):
        nonlocal done, failed
        async with sem:
            try:
                text = await translate_block(scope, b, quota=quota)
            except Exception as exc:
                text = None
                log.warning("段落翻译失败：%s", exc)
            async with lock:
                if text:
                    b.translation = text
                    b.translated_at = utcnow()
                    done += 1
                else:
                    failed += 1
                await queue.put(
                    {
                        "event": "block",
                        "data": {
                            "id": b.id,
                            "translation": text,
                            "done": done,
                            "failed": failed,
                            "total": len(todo),
                        },
                    }
                )

    async def runner():
        await asyncio.gather(*(work(b) for b in todo), return_exceptions=True)
        await scope.commit()
        await queue.put({"event": "done", "data": {"translated": done, "failed": failed}})

    task = asyncio.create_task(runner())
    try:
        while True:
            item = await queue.get()
            yield item
            if item["event"] == "done":
                break
    finally:
        if not task.done():
            task.cancel()


async def doc_stats(scope: UserScope, doc_id: str) -> dict:
    total, translated = (
        await scope.session.execute(
            select(
                func.count(DocBlock.id),
                func.count(DocBlock.translation),
            ).where(DocBlock.doc_id == doc_id)
        )
    ).one()
    return {"blocks": int(total or 0), "translated": int(translated or 0)}
