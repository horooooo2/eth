"""In-process event bus for V4.1 engine → internal WS clients."""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional


class EventBus:
    def __init__(self) -> None:
        self._seq = 0
        self._subscribers: List[asyncio.Queue] = []
        self._lock = asyncio.Lock()
        self._persist_hook: Optional[Callable[[Dict[str, Any]], Any]] = None

    def set_persist_hook(self, hook: Optional[Callable[[Dict[str, Any]], Any]]) -> None:
        self._persist_hook = hook

    @property
    def sequence(self) -> int:
        return self._seq

    def subscribe(self, maxsize: int = 200) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=maxsize)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        try:
            self._subscribers.remove(q)
        except ValueError:
            pass

    def emit(self, event_type: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        self._seq += 1
        event = {
            "event_id": f"py_{uuid.uuid4()}",
            "sequence": self._seq,
            "type": event_type,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "payload": payload or {},
        }
        dead: List[asyncio.Queue] = []
        for q in list(self._subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                try:
                    q.get_nowait()
                except Exception:
                    pass
                try:
                    q.put_nowait(event)
                except Exception:
                    dead.append(q)
            except Exception:
                dead.append(q)
        for q in dead:
            self.unsubscribe(q)
        if self._persist_hook is not None:
            try:
                self._persist_hook(event)
            except Exception:
                pass
        return event


_bus: Optional[EventBus] = None


def get_event_bus() -> EventBus:
    global _bus
    if _bus is None:
        _bus = EventBus()
    return _bus
