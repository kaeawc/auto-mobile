import { describe, expect, test } from "bun:test";
import {
  describeIosSdkTriggerFailure,
  withSdkRouteReadiness,
} from "../../../src/features/action/IosSdkTrigger";
import type { SdkTriggerRequest } from "../../../src/features/observe/ios/CtrlProxySdkTrigger";
import type { CtrlProxySdkTriggerResult } from "../../../src/features/observe/ios/types";
import { fixedBackoff } from "../../../src/utils/Backoff";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeIosSdkTriggerSender } from "../../fakes/FakeIosSdkTriggerSender";

const request = { module: "telephony", trigger: "phoneCall" } as unknown as SdkTriggerRequest;
const noRoute: CtrlProxySdkTriggerResult = {
  success: false,
  available: false,
  totalTimeMs: 0,
  error: "connection refused",
};

class AppearingRouteSender extends FakeIosSdkTriggerSender {
  constructor(private readonly appearsAfter: number) {
    super();
  }
  override async requestSdkTrigger(r: SdkTriggerRequest): Promise<CtrlProxySdkTriggerResult> {
    const ready = this.requests.length >= this.appearsAfter;
    this.result = ready
      ? { success: true, available: true, statusCode: 200, totalTimeMs: 0 }
      : noRoute;
    return super.requestSdkTrigger(r);
  }
}

describe("withSdkRouteReadiness", () => {
  test("succeeds once the route appears after N polls", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const inner = new AppearingRouteSender(3);
    const sender = withSdkRouteReadiness(inner, { timer, backoff: fixedBackoff(100) });
    const result = await sender.requestSdkTrigger(request);
    expect(result.success).toBe(true);
    expect(inner.requests).toHaveLength(4);
  });

  test("gives up with the no-route result after the bound", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const inner = new FakeIosSdkTriggerSender();
    inner.result = noRoute;
    const sender = withSdkRouteReadiness(inner, {
      timer,
      budgetMs: 1000,
      backoff: fixedBackoff(400),
    });
    const result = await sender.requestSdkTrigger(request);
    expect(result.available).toBe(false);
    expect(inner.requests).toHaveLength(4);
    expect(timer.now()).toBe(1000);
  });

  test("does not retry an unsupported runner", async () => {
    const timer = new FakeTimer();
    const inner = new FakeIosSdkTriggerSender();
    inner.result = { success: false, available: false, unsupported: true, totalTimeMs: 0 };
    const result = await withSdkRouteReadiness(inner, { timer }).requestSdkTrigger(request);
    expect(result.unsupported).toBe(true);
    expect(inner.requests).toHaveLength(1);
  });

  test("failure text names the notification-permission prompt", () => {
    expect(describeIosSdkTriggerFailure(noRoute, request, "phoneCall")).toContain(
      "notification-permission prompt",
    );
  });
});
