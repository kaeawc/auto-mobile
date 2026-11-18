import { describe, expect, test } from "bun:test";
import {
  requestStoreKit,
  STOREKIT_TIMEOUT_MS,
  type StoreKitRunnerRequest,
} from "../../../../src/features/observe/ios/CtrlProxyStoreKit";
import { createIosDelegateHarness } from "../../../helpers/iosDelegateHarness";

const bundleId = "com.example.app";

async function timeOut(request: StoreKitRunnerRequest, connected = true) {
  const h = createIosDelegateHarness({ connected });
  const pending = requestStoreKit(h.context, request);
  await Promise.resolve();
  await Promise.resolve();
  h.advanceTime(STOREKIT_TIMEOUT_MS + 1);
  return { result: await pending, h };
}

describe("requestStoreKit timeouts", () => {
  test("a dispatched buy that times out is marked dispatched and not retryable", async () => {
    const { result, h } = await timeOut({ action: "buy", bundleId, productId: "com.example.pro" });
    expect(h.sentMessages).toHaveLength(1);
    expect(result).toMatchObject({ success: false, dispatched: true, retryable: false });
    expect(result.error).toContain("may still apply");
  });

  test.each(["list", "clear"] as const)("a timed-out %s stays a plain failure", async (action) => {
    const { result } = await timeOut({ action, bundleId });
    expect(result).toEqual({
      success: false,
      totalTimeMs: 0,
      error: "Timeout waiting for storekit_result",
    });
  });

  test("a buy that never reached the runner is a plain not-connected failure", async () => {
    const h = createIosDelegateHarness({ connected: false });
    const result = await requestStoreKit(h.context, { action: "buy", bundleId, productId: "p" });
    expect(h.sentMessages).toEqual([]);
    expect(result).toEqual({ success: false, totalTimeMs: 0, error: "Not connected to CtrlProxy" });
  });
});

describe("requestStoreKit connect-only", () => {
  test("uses the open socket without connecting", async () => {
    const h = createIosDelegateHarness();
    const pending = requestStoreKit(
      h.context,
      { action: "list", bundleId },
      { requireExistingConnection: true },
    );
    await Promise.resolve();
    h.resolveLast({ success: true, totalTimeMs: 1, transactions: [] });
    expect(await pending).toMatchObject({ success: true, transactions: [] });
    expect(h.ensureConnectedCalls).toBe(0);
    expect(h.sentMessages[0]).toMatchObject({ type: "request_storekit", action: "list" });
  });

  test("refuses without connecting or setting the runner up when no socket is open", async () => {
    const h = createIosDelegateHarness();
    const result = await requestStoreKit(
      { ...h.context, getWebSocket: () => null },
      { action: "list", bundleId },
      { requireExistingConnection: true },
    );
    expect(h.ensureConnectedCalls).toBe(0);
    expect(h.sentMessages).toEqual([]);
    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain("does not start the runner");
  });
});
