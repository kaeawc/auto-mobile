import { describe, expect, test } from "bun:test";
import { CtrlProxyStorage } from "../../../../src/features/observe/ios/CtrlProxyStorage";
import { runWithAbortSignal } from "../../../../src/utils/AbortContext";
import { createIosDelegateHarness } from "../../../helpers/iosDelegateHarness";

/** #11750: the delegate stamps only a successful send, after connection and cancellation checks. */
describe("iOS storage write dispatch hooks", () => {
  for (const method of ["setPreference", "removePreference", "clearPreferenceStore"] as const) {
    function setup() {
      const h = createIosDelegateHarness();
      const storage = new CtrlProxyStorage(h.context);
      let count = 0;
      const options = { onDispatch: () => count++ };
      const write = () =>
        method === "setPreference"
          ? storage.setPreference("com.example", "prefs", "k", "v", "STRING", options)
          : method === "removePreference"
            ? storage.removePreference("com.example", "prefs", "k", options)
            : storage.clearPreferenceStore("com.example", "prefs", options);
      return { h, write, count: () => count };
    }

    test(`${method}: cancel while connecting never dispatches`, async () => {
      const { h, write, count } = setup();
      const connect = Promise.withResolvers<boolean>();
      h.context.ensureConnected = () => connect.promise;
      const call = new AbortController();
      const pending = runWithAbortSignal(call.signal, write);
      call.abort(new Error("cancel during connect"));
      connect.resolve(true);
      await expect(pending).rejects.toThrow("cancel during connect");
      expect(count()).toBe(0);
      expect(h.sentMessages).toEqual([]);
      expect(h.requestManager.getPendingCount()).toBe(0);
    });

    test(`${method}: successful send dispatches once before its result`, async () => {
      const { h, write, count } = setup();
      const pending = write();
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
      const beforeResult = count();
      expect(h.sentMessages).toHaveLength(1);
      h.resolveLast({ success: true, totalTimeMs: 0 });
      await pending;
      expect(beforeResult).toBe(1);
      expect(count()).toBe(1);
    });

    for (const failure of ["missing", "closed", "send throws"] as const) {
      test(`${method}: socket ${failure} never dispatches`, async () => {
        const { h, write, count } = setup();
        if (failure === "missing") {
          h.context.getWebSocket = () => null;
        } else {
          const ws = h.context.getWebSocket()!;
          if (failure === "closed") {
            ws.readyState = 3;
          } else {
            ws.send = () => {
              throw new Error("send failed");
            };
          }
        }
        try {
          const pending = write().catch((error: unknown) => error);
          for (let i = 0; i < 10; i++) {
            await Promise.resolve();
          }
          h.advanceTime(5000);
          expect(await pending).toBeInstanceOf(Error);
          expect(count()).toBe(0);
          expect(h.sentMessages).toEqual([]);
        } finally {
          h.requestManager.reset();
        }
      });
    }

    for (const failure of ["false", "throw"] as const) {
      test(`${method}: connect ${failure} never dispatches`, async () => {
        const { h, write, count } = setup();
        h.context.ensureConnected = async () => {
          if (failure === "throw") {
            throw new Error("connect failed");
          }
          return false;
        };
        await expect(write()).rejects.toThrow();
        expect(count()).toBe(0);
        expect(h.sentMessages).toEqual([]);
      });
    }
  }
});
