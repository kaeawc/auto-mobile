import { describe, expect, test } from "bun:test";
import {
  ImeSpanService,
  isImeRestorationFailure,
  type ImeSpanHost,
} from "../../../../src/features/action/sendkeys/ImeSpan";
import { ImeRestorationError } from "../../../../src/features/action/sendkeys/ImeRestorationError";
import type { SendKeysCommandExecutor } from "../../../../src/features/action/SendKeys";
import { DevicePendingImeRestores } from "../../../../src/features/action/sendkeys/PendingImeRestore";
import { FakeTimer } from "../../../fakes/FakeTimer";

type Execution = Awaited<ReturnType<NonNullable<SendKeysCommandExecutor["withImeSpan"]>>>;
const snapshot = { prior: "keyboard/.Ime", wasEnabled: false, priorSubtype: { id: 7 } };
function harness() {
  const calls: string[] = [];
  const host: ImeSpanHost = {
    deviceId: "ime-span-unit",
    verifySafeImeRecovery: async () => true,
    restoreIme: async (prior, enabled, subtype) => {
      calls.push(`${prior}:${enabled}:${subtype.id}`);
    },
    getPinnedUser: () => undefined,
    setPinnedUser: () => {},
    clearPinnedUser: () => {
      calls.push("clearPinnedUser");
    },
  };
  const pending = new DevicePendingImeRestores();
  return { service: new ImeSpanService(host, pending), host, calls, pending };
}
function execution(): Execution {
  return { results: [{ index: 0, action: "type", resolvedMode: "ime", success: true }] };
}

describe("ImeSpanService", () => {
  test("isolates overlapping calls and releases before deferred restoration", async () => {
    const { service, calls, pending, host } = harness();
    const timer = new FakeTimer();
    const first = service.withImeSpan(async () => {
      const span = service.imeSpan!;
      await service.acquireImeSpan(span);
      span.snapshot = snapshot;
      await timer.sleep(1);
      expect(service.imeSpan).toBe(span);
      return execution();
    });
    await service.withImeSpan(async () => {
      expect(service.imeSpan?.snapshot).toBeUndefined();
      timer.advanceTime(1);
      return execution();
    });
    // Admission may not yet have reached the fake sleep.
    timer.resolveAll();
    expect((await first).restorationFailed).toBeUndefined();
    expect(calls).toEqual(["clearPinnedUser"]);
    await pending.flush(host.deviceId);
    expect(calls).toEqual(["clearPinnedUser", "keyboard/.Ime:false:7", "clearPinnedUser"]);
    expect(service.imeSpan).toBeUndefined();
  });

  test("consumes a failed snapshot once and reports the failure on the IME type", async () => {
    const { service, host, calls } = harness();
    host.restoreIme = async () => {
      calls.push("restore");
      throw new ImeRestorationError("restore failed");
    };
    const result = await service.withImeSpan(async () => {
      await service.acquireImeSpan(service.imeSpan!);
      service.imeSpan!.snapshot = snapshot;
      return { ...execution(), failure: { index: 0, error: "commit failed" } };
    });
    expect(result).toMatchObject({
      restorationFailed: true,
      failure: { index: 0, error: "Text commit succeeded, but restore failed" },
      results: [{ success: false }],
    });
    expect(calls).toEqual(["restore", "clearPinnedUser"]);
  });

  test("aggregates action and restoration errors and releases the lock", async () => {
    const { service, calls } = harness();
    const actionError = new Error("action failed");
    const promise = service.withImeSpan(async () => {
      const span = service.imeSpan!;
      await service.acquireImeSpan(span);
      span.snapshot = snapshot;
      span.safeToRestore = false;
      throw actionError;
    });
    const failure = await promise.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(isImeRestorationFailure(failure)).toBe(true);
    expect(calls).toEqual(["clearPinnedUser"]);
    await service.withImeSpan(async () => {
      await service.acquireImeSpan(service.imeSpan!);
      return execution();
    });
    expect(calls).toEqual(["clearPinnedUser", "clearPinnedUser"]);
  });
});
