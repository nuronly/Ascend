"""文档模式 API（PLAN §3.5）。"""

from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.api.deps import CurrentUser, Scope, user_quota
from app.api.sse import sse_response
from app.models.card import STATE_ARCHIVED, Card
from app.models.document import DocBlock, Document
from app.services import docparse
from app.services import document as svc

router = APIRouter(prefix="/documents", tags=["documents"])

MAX_UPLOAD = 40 * 1024 * 1024  # 40MB


class ImportUrlIn(BaseModel):
    url: str = Field(min_length=4, max_length=1000)


def _doc_dict(d: Document) -> dict:
    return {
        "id": d.id,
        "filename": d.filename,
        "title": d.title or d.filename,
        "mime": d.mime,
        "origin": d.origin,
        "source_url": d.source_url,
        "page_count": d.page_count,
        "parse_status": d.parse_status,
        "error": d.error,
        "meta": d.meta or {},
        "created_at": d.created_at.isoformat(),
    }


@router.get("")
async def list_documents(scope: Scope, limit: int = Query(60, le=200)) -> list[dict]:
    docs = await scope.all(
        scope.select(Document).order_by(Document.created_at.desc()).limit(limit)
    )
    if not docs:
        return []
    ids = [d.id for d in docs]

    counts = dict(
        (
            await scope.session.execute(
                select(DocBlock.doc_id, func.count(DocBlock.id))
                .where(DocBlock.doc_id.in_(ids))
                .group_by(DocBlock.doc_id)
            )
        ).all()
    )
    translated = dict(
        (
            await scope.session.execute(
                select(DocBlock.doc_id, func.count(DocBlock.id))
                .where(DocBlock.doc_id.in_(ids), DocBlock.translation.is_not(None))
                .group_by(DocBlock.doc_id)
            )
        ).all()
    )
    cards = dict(
        (
            await scope.session.execute(
                select(DocBlock.doc_id, func.count(Card.id))
                .join(Card, Card.source_doc_block_id == DocBlock.id)
                .where(
                    DocBlock.doc_id.in_(ids),
                    Card.user_id == scope.user_id,
                    Card.state != STATE_ARCHIVED,
                )
                .group_by(DocBlock.doc_id)
            )
        ).all()
    )

    out = []
    for d in docs:
        item = _doc_dict(d)
        item["stats"] = {
            "blocks": int(counts.get(d.id, 0)),
            "translated": int(translated.get(d.id, 0)),
            "cards": int(cards.get(d.id, 0)),
        }
        out.append(item)
    return out


@router.post("/upload", status_code=status.HTTP_201_CREATED)
async def upload(scope: Scope, file: UploadFile = File(...)) -> dict:
    name = file.filename or "未命名"
    if not name.lower().endswith(docparse.SUPPORTED_EXT):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"暂不支持这种格式。可用：{'、'.join(docparse.SUPPORTED_EXT)}",
        )
    data = await file.read()
    if len(data) > MAX_UPLOAD:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "文件超过 40MB")
    if not data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "文件是空的")

    doc = await svc.import_upload(
        scope, filename=name, data=data, mime=file.content_type or ""
    )
    if doc.parse_status == "failed":
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, doc.error or "解析失败")
    return _doc_dict(doc)


@router.post("/import-url", status_code=status.HTTP_201_CREATED)
async def import_url(body: ImportUrlIn, scope: Scope) -> dict:
    """从 URL 导入。arXiv 链接或纯 ID 会自动走 HTML 版。"""
    doc = await svc.import_url(scope, body.url.strip())
    if doc.parse_status == "failed":
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, doc.error or "导入失败")
    return _doc_dict(doc)


@router.get("/{doc_id}")
async def get_document(
    doc_id: str,
    scope: Scope,
    offset: int = Query(0, ge=0),
    limit: int = Query(400, le=1500),
) -> dict:
    doc = await scope.require(Document, doc_id, "文档")
    blocks = await scope.all(
        select(DocBlock)
        .where(DocBlock.doc_id == doc.id)
        .order_by(DocBlock.page, DocBlock.idx)
        .offset(offset)
        .limit(limit)
    )
    # 每段挂了几张卡，用于在正文旁显示标记
    card_counts = dict(
        (
            await scope.session.execute(
                select(Card.source_doc_block_id, func.count(Card.id))
                .where(
                    Card.user_id == scope.user_id,
                    Card.source_doc_block_id.in_([b.id for b in blocks] or [""]),
                    Card.state != STATE_ARCHIVED,
                )
                .group_by(Card.source_doc_block_id)
            )
        ).all()
    )

    return {
        **_doc_dict(doc),
        "stats": await svc.doc_stats(scope, doc.id),
        "blocks": [
            {
                "id": b.id,
                "page": b.page,
                "idx": b.idx,
                "type": b.block_type,
                "text": b.text,
                "translation": b.translation,
                "cards": int(card_counts.get(b.id, 0)),
            }
            for b in blocks
        ],
        "offset": offset,
    }


@router.get("/{doc_id}/translate")
async def translate(
    doc_id: str, request: Request, scope: Scope, user: CurrentUser
):
    """整篇翻译，SSE 汇报逐段进度。已翻过的段落直接命中缓存。"""
    await scope.require(Document, doc_id, "文档")
    return await sse_response(
        svc.stream_translate(scope, doc_id, quota=user_quota(user)), request
    )


@router.post("/{doc_id}/blocks/{block_id}/translate")
async def translate_one(
    doc_id: str, block_id: str, scope: Scope, user: CurrentUser
) -> dict:
    """单段翻译 / 重译。"""
    await scope.require(Document, doc_id, "文档")
    block = await scope.require_doc_block(block_id)
    text = await svc.translate_block(scope, block, quota=user_quota(user))
    if text:
        block.translation = text
        from app.core.types import utcnow

        block.translated_at = utcnow()
        await scope.commit()
    return {"id": block.id, "translation": text}


@router.patch("/{doc_id}")
async def rename(doc_id: str, scope: Scope, title: str = Query(max_length=500)) -> dict:
    doc = await scope.require(Document, doc_id, "文档")
    doc.title = title.strip()[:500]
    await scope.commit()
    return _doc_dict(doc)


@router.delete("/{doc_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove(doc_id: str, scope: Scope) -> None:
    doc = await scope.require(Document, doc_id, "文档")
    await scope.session.delete(doc)
    await scope.commit()


@router.get("/meta/formats")
async def formats() -> dict:
    return {
        "extensions": list(docparse.SUPPORTED_EXT),
        "max_mb": MAX_UPLOAD // (1024 * 1024),
        "note": "arXiv 链接或论文编号会自动走 HTML 版，切段质量比 PDF 好一个量级",
    }
