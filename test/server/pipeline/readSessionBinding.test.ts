import { describe, expect, test } from "bun:test";
import {
  readSessionBindingRefusal,
  type ReadSessionBindingView,
} from "../../../src/server/pipeline/readSessionBinding";
import {
  READ_SESSION_NOT_BOUND_CODE,
  ReadSessionNotBoundError,
} from "../../../src/daemon/ReadSessionNotBoundError";
import { shapeToolCallError } from "../../../src/daemon/shapeToolCallError";

const SESSION = "11111111-2222-4333-8444-555555555555";
const OWNER = "socket-owner";
const OTHER = "socket-other";

/** A fake daemon view: which connected connection owns each session, tokens and broker grants. */
class FakeReadSessionBindingView implements ReadSessionBindingView {
  /** Session (or base) -> its connected owning connection. */
  readonly owners = new Map<string, string>([[SESSION, OWNER]]);
  readonly tokens = new Map<string, Set<string>>();
  readonly grants = new Map<string, Set<string>>();

  isSessionOwnedByOtherConnection(sessionUuid: string, mcpSessionId: string): boolean {
    const base = sessionUuid.split(":", 1)[0];
    const owner = this.owners.get(sessionUuid) ?? this.owners.get(base);
    return owner !== undefined && owner !== mcpSessionId;
  }
  connectionPresentsSessionOwnerToken(sessionUuid: string, mcpSessionId: string): boolean {
    return this.tokens.get(mcpSessionId)?.has(sessionUuid) === true;
  }
  brokerGrantedSessions(mcpSessionId: string): ReadonlySet<string> | undefined {
    return this.grants.get(mcpSessionId);
  }
}

function refusal(
  view: ReadSessionBindingView,
  mcpSessionId: string | undefined,
  sessionUuid = SESSION,
) {
  return readSessionBindingRefusal(view, { toolName: "observe", sessionUuid, mcpSessionId });
}

describe("read session binding (#13540)", () => {
  test("the connection holding the session binding may read under it", () => {
    expect(refusal(new FakeReadSessionBindingView(), OWNER)).toBeUndefined();
  });

  test("a derived label session is held through its base", () => {
    expect(refusal(new FakeReadSessionBindingView(), OWNER, `${SESSION}:phone`)).toBeUndefined();
  });

  test("a connection presenting the session's owner token may read under it", () => {
    const view = new FakeReadSessionBindingView();
    view.tokens.set(OTHER, new Set([SESSION]));
    expect(refusal(view, OTHER)).toBeUndefined();
  });

  test("a broker connection granted the session may read under it", () => {
    const view = new FakeReadSessionBindingView();
    view.grants.set(OTHER, new Set([SESSION]));
    expect(refusal(view, OTHER)).toBeUndefined();
  });

  test("an unbound connection naming another connected client's session is refused", () => {
    const error = refusal(new FakeReadSessionBindingView(), OTHER);
    expect(error).toBeInstanceOf(ReadSessionNotBoundError);
    expect(error?.message).toContain(SESSION);
    expect(error?.message).toContain("owner token");
  });

  test("an unbound connection naming another client's derived label session is refused", () => {
    const error = refusal(new FakeReadSessionBindingView(), OTHER, `${SESSION}:phone`);
    expect(error).toBeInstanceOf(ReadSessionNotBoundError);
  });

  test("a broker grant of some other session does not authorize the read", () => {
    const view = new FakeReadSessionBindingView();
    view.grants.set(OTHER, new Set(["some-other-session"]));
    expect(refusal(view, OTHER)).toBeInstanceOf(ReadSessionNotBoundError);
  });

  test("the refusal is typed, non-retryable and names the missing binding on the wire", () => {
    const error = refusal(new FakeReadSessionBindingView(), OTHER)!;
    expect(error.code).toBe(READ_SESSION_NOT_BOUND_CODE);
    expect(error.retryable).toBe(false);
    const shaped = shapeToolCallError(error, { source: "MCP", toolName: "observe" });
    const wire = JSON.parse(shaped.content[0].text) as Record<string, unknown>;
    expect(wire).toMatchObject({
      success: false,
      code: READ_SESSION_NOT_BOUND_CODE,
      action: "observe",
      sessionUuid: SESSION,
      missingBinding: "session",
      retryable: false,
    });
    expect(wire).not.toHaveProperty("nextAction");
  });

  test("a session no connected client owns (a finished --cli call's) is not refused", () => {
    const view = new FakeReadSessionBindingView();
    view.owners.clear();
    expect(refusal(view, OTHER)).toBeUndefined();
  });

  test("an id naming no owned session (an IDE observer session) is not judged", () => {
    expect(refusal(new FakeReadSessionBindingView(), OTHER, "observer-uuid")).toBeUndefined();
  });

  test("a call with no connection identity or no session is not judged", () => {
    const view = new FakeReadSessionBindingView();
    expect(refusal(view, undefined)).toBeUndefined();
    expect(
      readSessionBindingRefusal(view, {
        toolName: "observe",
        sessionUuid: undefined,
        mcpSessionId: OTHER,
      }),
    ).toBeUndefined();
  });
});
