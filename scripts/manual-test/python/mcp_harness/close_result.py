from __future__ import annotations
import traceback as tb
from dataclasses import asdict, dataclass
from typing import Any
import anyio

@dataclass(frozen=True)
class CloseResult:
    status: str
    classification: str
    exception_class: str | None
    leaves: list[str]
    traceback: str | None
    elapsed_ms: float

    def json(self) -> dict[str, Any]:
        value = asdict(self)
        value["exceptionClass"] = value.pop("exception_class")
        value["elapsedMs"] = value.pop("elapsed_ms")
        return value

def leaves(exc: BaseException) -> list[BaseException]:
    return [leaf for sub in exc.exceptions for leaf in leaves(sub)] if isinstance(exc, BaseExceptionGroup) else [exc]

def class_name(exc: BaseException) -> str:
    return f"{type(exc).__module__}.{type(exc).__qualname__}"

def exception_json(exc: BaseException) -> dict[str, Any]:
    return {"class": class_name(exc), "message": str(exc), "leaves": [class_name(e) for e in leaves(exc)],
            "traceback": "".join(tb.format_exception(exc))}

def classify_close(exc: BaseException | None, elapsed_ms: float, timed_out: bool = False) -> CloseResult:
    flat = leaves(exc) if exc is not None else []
    classification = "none"
    if timed_out:
        classification = "timeout"
    elif any(isinstance(e, RuntimeError) and "cancel scope" in str(e).lower() for e in flat):
        classification = "cancel-scope-misuse"
    elif any(isinstance(e, (anyio.BrokenResourceError, anyio.ClosedResourceError, BrokenPipeError,
                           ConnectionError, anyio.EndOfStream)) for e in flat):
        classification = "transport-broken"
    elif any(isinstance(e, ProcessLookupError) for e in flat):
        classification = "server-gone"
    elif exc is not None:
        classification = "other"
    return CloseResult("CLOSE_HANG" if timed_out else "CLOSE_RAISED" if exc else "CLOSE_OK", classification,
                       class_name(exc) if exc else None, [class_name(e) for e in flat],
                       "".join(tb.format_exception(exc)) if exc else None, elapsed_ms)

def worst_exit(codes: list[int]) -> int:
    return max(codes, key={0: 0, 1: 1, 3: 2, 2: 3}.__getitem__, default=0)
