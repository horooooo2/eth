"""DeepSeek /responses + web_search client (search only, no judgment)."""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any
from urllib import error, request

from ..narrator.llm_log import log_llm_call

RESPONSES_URL = "https://api.deepseek.com/responses"
DEFAULT_MODEL = "deepseek-v4-flash"
DEFAULT_TIMEOUT_S = 15.0


class SearchError(RuntimeError):
    """Raised when a search request fails."""


@dataclass
class SearchResult:
    query: str
    answer: str
    sources: list[dict[str, str]] = field(default_factory=list)
    raw_response: dict[str, Any] = field(default_factory=dict)
    latency_ms: int = 0
    token_usage: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "query": self.query,
            "answer": self.answer,
            "sources": list(self.sources),
            "raw_response": self.raw_response,
            "latency_ms": self.latency_ms,
            "token_usage": dict(self.token_usage),
        }


def _looks_like_tool_markup(text: str) -> bool:
    t = text or ""
    markers = ("DSML", "search_query", "tool_call", "invoke name=", "<|")
    return any(m in t for m in markers)


def _extract_output_text(payload: dict[str, Any]) -> str:
    text = payload.get("output_text")
    if isinstance(text, str) and text.strip() and not _looks_like_tool_markup(text):
        return text.strip()
    # Some Responses payloads nest final text under top-level "text"
    top_text = payload.get("text")
    if isinstance(top_text, str) and top_text.strip() and not _looks_like_tool_markup(top_text):
        return top_text.strip()
    if isinstance(top_text, dict):
        for key in ("content", "value", "text"):
            val = top_text.get(key)
            if isinstance(val, str) and val.strip() and not _looks_like_tool_markup(val):
                return val.strip()

    chunks: list[str] = []
    for item in payload.get("output") or []:
        if not isinstance(item, dict):
            continue
        itype = item.get("type")
        if itype in ("message", "output_text"):
            # Prefer completed assistant messages only
            if itype == "message" and item.get("role") not in (None, "assistant"):
                continue
            content = item.get("content")
            if isinstance(content, str) and content.strip():
                if not _looks_like_tool_markup(content):
                    chunks.append(content.strip())
            elif isinstance(content, list):
                for part in content:
                    if not isinstance(part, dict):
                        continue
                    ptype = part.get("type")
                    if ptype in ("output_text", "text") and part.get("text"):
                        piece = str(part["text"]).strip()
                        if piece and not _looks_like_tool_markup(piece):
                            chunks.append(piece)
                    elif part.get("text") and isinstance(part.get("text"), str):
                        piece = str(part["text"]).strip()
                        if piece and not _looks_like_tool_markup(piece):
                            chunks.append(piece)
            elif item.get("text"):
                piece = str(item["text"]).strip()
                if piece and not _looks_like_tool_markup(piece):
                    chunks.append(piece)
    return "\n".join(c for c in chunks if c).strip()


def _extract_sources(payload: dict[str, Any], max_results: int) -> list[dict[str, str]]:
    sources: list[dict[str, str]] = []
    seen: set[str] = set()

    def _add(title: str, url: str, snippet: str = "") -> None:
        key = url or title
        if not key or key in seen:
            return
        seen.add(key)
        sources.append(
            {
                "title": (title or url or "source")[:300],
                "url": (url or "")[:500],
                "snippet": (snippet or "")[:1000],
            }
        )

    for item in payload.get("output") or []:
        if not isinstance(item, dict):
            continue
        if item.get("type") != "web_search_call":
            continue
        action = item.get("action") if isinstance(item.get("action"), dict) else {}
        for res in action.get("sources") or action.get("results") or []:
            if isinstance(res, dict):
                _add(
                    str(res.get("title") or ""),
                    str(res.get("url") or res.get("link") or ""),
                    str(res.get("snippet") or res.get("summary") or ""),
                )
        for cite in item.get("citations") or []:
            if isinstance(cite, dict):
                _add(
                    str(cite.get("title") or ""),
                    str(cite.get("url") or ""),
                    str(cite.get("snippet") or ""),
                )
        if len(sources) >= max_results:
            break

    # Fallback: annotations on message content
    if not sources:
        for item in payload.get("output") or []:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if not isinstance(content, list):
                continue
            for part in content:
                if not isinstance(part, dict):
                    continue
                for ann in part.get("annotations") or []:
                    if not isinstance(ann, dict):
                        continue
                    _add(
                        str(ann.get("title") or ""),
                        str(ann.get("url") or ""),
                        str(ann.get("snippet") or ""),
                    )
    return sources[:max_results]


def _token_usage(payload: dict[str, Any]) -> dict[str, int]:
    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
    prompt = int(usage.get("input_tokens") or usage.get("prompt_tokens") or 0)
    completion = int(usage.get("output_tokens") or usage.get("completion_tokens") or 0)
    return {"prompt": prompt, "completion": completion}


class SearchClient:
    """Thin wrapper around DeepSeek Responses API with server-side web_search."""

    def __init__(
        self,
        api_key: str,
        model: str = DEFAULT_MODEL,
        *,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        base_url: str = RESPONSES_URL,
    ) -> None:
        self.api_key = (api_key or "").strip()
        self.model = model or DEFAULT_MODEL
        self.timeout_s = float(timeout_s)
        self.base_url = base_url.rstrip("/")

    def search(self, query: str, max_results: int = 5) -> SearchResult:
        q = (query or "").strip()
        if not q:
            raise SearchError("empty search query")
        if not self.api_key:
            raise SearchError("DEEPSEEK_API_KEY missing")

        last_err: SearchError | None = None
        for attempt in range(2):
            try:
                return self._search_once(q, max_results=max_results, attempt=attempt)
            except SearchError as exc:
                last_err = exc
                # Retry once on empty / incomplete tool-loop answers
                if "empty search answer" not in str(exc):
                    raise
                time.sleep(0.4)
        assert last_err is not None
        raise last_err

    def _search_once(self, q: str, *, max_results: int, attempt: int) -> SearchResult:
        body = {
            "model": self.model,
            "input": (
                f"请用中文简要汇总与「{q}」相关的最新公开信息。"
                f"优先给出事实与数字，控制在 200 字内，并注明来源倾向。"
                + (" 请直接给出最终摘要，不要输出工具调用标记。" if attempt else "")
            ),
            "tools": [{"type": "web_search"}],
            "tool_choice": "auto",
            "max_output_tokens": 800,
        }
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        req = request.Request(
            self.base_url,
            data=data,
            method="POST",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        started = time.perf_counter()
        try:
            with request.urlopen(req, timeout=self.timeout_s) as resp:
                raw = resp.read().decode("utf-8")
        except error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8", errors="replace")[:500]
            except Exception:  # noqa: BLE001
                pass
            latency_ms = int((time.perf_counter() - started) * 1000)
            log_llm_call(
                component="search",
                scene="web_search",
                latency_ms=latency_ms,
                status=f"http_{exc.code}",
            )
            raise SearchError(f"search HTTP {exc.code}: {detail}") from exc
        except Exception as exc:  # noqa: BLE001
            latency_ms = int((time.perf_counter() - started) * 1000)
            log_llm_call(
                component="search",
                scene="web_search",
                latency_ms=latency_ms,
                status="error",
            )
            raise SearchError(f"search failed: {exc}") from exc

        latency_ms = int((time.perf_counter() - started) * 1000)
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            log_llm_call(
                component="search",
                scene="web_search",
                latency_ms=latency_ms,
                status="bad_json",
            )
            raise SearchError("invalid JSON from /responses") from exc

        if not isinstance(payload, dict):
            log_llm_call(
                component="search",
                scene="web_search",
                latency_ms=latency_ms,
                status="bad_payload",
            )
            raise SearchError("unexpected /responses payload")

        answer = _extract_output_text(payload)
        sources = _extract_sources(payload, max(1, int(max_results)))
        usage = _token_usage(payload)
        log_llm_call(
            component="search",
            scene="web_search",
            latency_ms=latency_ms,
            status="ok" if answer else "empty_answer",
            prompt_tokens=usage.get("prompt"),
            completion_tokens=usage.get("completion"),
        )
        if not answer and sources:
            bits = []
            for s in sources[:3]:
                title = (s.get("title") or "").strip()
                snip = (s.get("snippet") or "").strip()
                if title and snip:
                    bits.append(f"{title}: {snip}")
                elif title:
                    bits.append(title)
                elif snip:
                    bits.append(snip)
            answer = "；".join(bits)[:500]
        if not answer:
            status = payload.get("status")
            types = [
                str(it.get("type"))
                for it in (payload.get("output") or [])
                if isinstance(it, dict)
            ]
            raise SearchError(
                f"empty search answer (status={status}, output_types={types})"
            )
        return SearchResult(
            query=q,
            answer=answer,
            sources=sources,
            raw_response=payload,
            latency_ms=latency_ms,
            token_usage=usage,
        )
