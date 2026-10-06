import { describe, expect, test } from "bun:test";
import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { SimctlCommandTimeoutError } from "../../../src/utils/ios-cmdline-tools/SimctlCommandTimeoutError";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeTimer } from "../../fakes/FakeTimer";

const UDID = "11111111-2222-3333-4444-555555555555";
const bundleId = "com.example.app";

function wedgedUninstall() {
  const timer = new FakeTimer();
  let childSignal: AbortSignal | undefined;
  const client = new SimCtlClient(
    null,
    async (_file, args, _maxBuffer, signal) => {
      if (args[1] !== "uninstall") {
        return createExecResult("", "");
      }
      childSignal = signal;
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      });
    },
    timer,
    "darwin",
  );
  return { client, timer, childSignal: () => childSignal };
}

describe("SimCtlClient.uninstallApp bound and signal (#10077)", () => {
  test("a wedged uninstall past its timeout is killed and rejects with the typed timeout", async () => {
    const { client, timer, childSignal } = wedgedUninstall();

    const uninstall = client.uninstallApp(bundleId, UDID, { timeoutMs: 30_000 });
    const outcome = uninstall.then(
      () => undefined,
      (error: unknown) => error,
    );
    await Promise.resolve();
    timer.advanceTime(30_000);

    const failure = await outcome;
    expect(failure).toBeInstanceOf(SimctlCommandTimeoutError);
    expect((failure as Error).message).toContain(`xcrun simctl uninstall ${UDID} ${bundleId}`);
    expect(childSignal()?.aborted).toBe(true);
  });

  test("the caller's signal kills the uninstall child", async () => {
    const { client, childSignal } = wedgedUninstall();
    const controller = new AbortController();

    const uninstall = client
      .uninstallApp(bundleId, UDID, { timeoutMs: 30_000, signal: controller.signal })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await Promise.resolve();
    controller.abort();

    const failure = await uninstall;
    expect(failure).not.toBeInstanceOf(SimctlCommandTimeoutError);
    expect(childSignal()?.aborted).toBe(true);
  });

  test("a plain non-zero exit is not classified as a timeout", async () => {
    const failure = new Error("Unable to uninstall");
    const client = new SimCtlClient(
      null,
      async (_file, args) => {
        if (args[1] === "uninstall") {
          throw failure;
        }
        return createExecResult("", "");
      },
      new FakeTimer(),
      "darwin",
    );

    await expect(client.uninstallApp(bundleId, UDID, { timeoutMs: 30_000 })).rejects.toBe(failure);
  });
});
