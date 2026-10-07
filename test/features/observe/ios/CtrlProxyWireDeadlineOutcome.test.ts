import { describe, expect, test } from "bun:test";
import { CtrlProxyGestures } from "../../../../src/features/observe/ios/CtrlProxyGestures";
import { iosWireDeadlineParams } from "../../../../src/features/observe/ios/CtrlProxyDispatch";
import { createIosDelegateHarness } from "../../../helpers/iosDelegateHarness";

// Wire deadline (#10084) x unconfirmed-dispatch handling (#10016 follow-ups): the runner dropping
// a queued command for a passed deadline answers with a typed error, which the action layer must
// be able to tell apart from "written to the socket, no reply ever came".
describe("iOS wire deadline outcome vs unconfirmed dispatch", () => {
  const budgetMs = 50;
  // CommandError.deadlineExceeded(gestureCompleted: false) as the runner words it.
  const droppedByRunner =
    "Command request_tap_coordinates exceeded deadline at 1234ms (gesture was not started)";

  async function tapWithWireDeadline() {
    const h = createIosDelegateHarness();
    h.context.wireDeadlineParams = iosWireDeadlineParams;
    const pending = new CtrlProxyGestures(h.context).requestTapCoordinates(
      1,
      2,
      budgetMs,
      budgetMs,
      undefined,
      undefined,
      new AbortController().signal,
    );
    await Promise.resolve();
    return { h, pending };
  }

  test("the tap carries the host's wait budget as its wire deadline", async () => {
    const { h, pending } = await tapWithWireDeadline();

    expect(h.sentMessages).toHaveLength(1);
    expect(h.sentMessages[0]).toMatchObject({
      type: "request_tap_coordinates",
      timeoutMs: budgetMs,
    });
    h.advanceTime(budgetMs);
    await pending;
  });

  test("a runner reply that dropped the command is acknowledged and carries no do-not-retry marker", async () => {
    const { h, pending } = await tapWithWireDeadline();

    h.requestManager.resolveError(h.lastRequestId()!, droppedByRunner);
    const result = await pending;

    // Acknowledged: the action layer's `dispatched && acknowledged === false` test is false, so
    // this surfaces as a plain "not executed" failure, not as an indeterminate outcome.
    expect(result).toMatchObject({ success: false, dispatched: true, acknowledged: true });
    expect(result.error).toContain("gesture was not started");
    expect(result.retryable).toBeUndefined();
  });

  test("no reply before the host gives up stays dispatched, unacknowledged and not retryable", async () => {
    const { h, pending } = await tapWithWireDeadline();

    h.advanceTime(budgetMs);
    const result = await pending;

    expect(result).toMatchObject({
      success: false,
      dispatched: true,
      acknowledged: false,
      retryable: false,
    });
    expect(result.error).not.toContain("gesture was not started");
  });
});
