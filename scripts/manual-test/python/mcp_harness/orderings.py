"""One shared expectation table; characterize reports measurements, never coerces them."""
from __future__ import annotations
from dataclasses import dataclass

@dataclass(frozen=True)
class Ordering:
    description: str
    expected: dict[int, tuple[str, ...]]
    avoidable_by: str = "none needed"

OK = {1: ("CLOSE_OK",), 2: ("CLOSE_OK",)}
BROKEN = {1: ("CLOSE_RAISED",), 2: ("CLOSE_OK",)}
ORDERINGS: dict[str, Ordering] = {
    "normal": Ordering("normal close after completed calls", OK),
    "server-exits-then-idle-close": Ordering("server exits (after replying), client idles then closes", OK),
    "server-exits-then-call": Ordering("server exits, client calls again, then closes", {1: ("CLOSE_OK", "CLOSE_RAISED"), 2: ("CLOSE_OK",)}),
    "server-exits-during-call": Ordering("server exits during a call", OK),
    "mid-call-cancel": Ordering("in-flight call cancelled, then close", OK),
    "mid-call-leave-contexts": Ordering("contexts left with a call in flight (answer much later)", OK),
    "sigterm-then-close": Ordering("SIGTERM server, then close", OK),
    "sigkill-then-close": Ordering("SIGKILL server, then close", OK),
    "server-closes-stdout-then-close": Ordering("server closes stdout, stays alive, then close", OK),
    "server-ignores-stdin-eof": Ordering("server ignores stdin EOF", OK, "server"),
    "server-ignores-eof-and-sigterm": Ordering("server ignores stdin EOF and SIGTERM", OK, "server"),
    "notification-spam-then-close": Ordering("server emits notifications continuously while client closes", BROKEN, "SDK"),
    "server-writes-after-stdin-eof": Ordering("server writes messages AFTER stdin EOF, then exits", BROKEN, "server"),
    "late-response-after-leave": Ordering("in-flight response arrives ~200 ms into close window", BROKEN, "SDK"),
    "session-closed-transport-open-spam": Ordering("session exited, transport open, server emits notifications", BROKEN, "SDK"),
    "two-clients-own-tasks": Ordering("two clients in own tasks, overlapping independent closes", OK),
    "two-clients-exit-stack-non-lifo": Ordering("two AsyncExitStacks closed non-LIFO from one task", {1: ("CLOSE_RAISED",), 2: ("CLOSE_RAISED",)}, "client"),
    "close-in-other-task": Ordering("contexts closed from a different task than entered", {1: ("CLOSE_RAISED", "CLOSE_HANG"), 2: ("CLOSE_RAISED", "CLOSE_HANG")}, "client"),
    "earlier-application-exception": Ordering("earlier application exception reported separately", OK),
    "caller-cancellation": Ordering("caller cancelled while call is in flight", OK),
}
