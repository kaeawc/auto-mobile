import { describe, expect, test } from "bun:test";
import {
  nativeIosMutationResetPort,
  nativeIosResetHealth,
} from "../../../src/daemon/sessionBroker/iosResetNativePorts";
import type { DeviceMutationResetContext } from "../../../src/daemon/sessionBroker/mutations/reset";
import type { ExecResult } from "../../../src/models/ExecResult";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainUntilQuiescent } from "../../helpers/fakeTimerStepping";

function harness() {
  const timer = new FakeTimer();
  const child = new FakeChildProcess(timer);
  const controller = new AbortController();
  const context: DeviceMutationResetContext = {
    scope: {
      deviceId: "reset-pasteboard-device",
      incarnation: "generation",
      sessionUuid: "session",
    },
    signal: controller.signal,
    assertOwned: async () => {
      controller.signal.throwIfAborted();
    },
  };
  const commands: string[][] = [];
  const port = nativeIosMutationResetPort(
    {
      listAppsOrThrow: async () => [],
      executeCommandArgs: async () =>
        ({
          stdout: "",
          stderr: "",
          toString: () => "",
          trim: () => "",
          includes: () => false,
        }) satisfies ExecResult,
      startCommandArgs: async (args) => {
        commands.push(args);
        return child;
      },
    },
    timer,
  );
  const write = () =>
    port.revert(
      {
        kind: "clipboard",
        key: "device",
        priorValue: { state: "present", value: "prior text" },
        toolName: "clipboard",
      },
      context,
    );
  return { timer, child, controller, context, commands, port, write };
}

describe("iOS native reset ports", () => {
  test("pasteboard restoration uses simctl argv and stdin, then confirms child exit", async () => {
    const rig = harness();
    const operation = rig.write();
    await drainUntilQuiescent(rig.timer);
    expect(rig.commands).toEqual([["pbcopy", "reset-pasteboard-device"]]);
    expect(rig.child.getStdinData().toString()).toBe("prior text");
    rig.child.simulateExit(0);
    rig.timer.advanceTime(0);
    await operation;
    await rig.port.assertSettled(rig.context);
  });

  test("unconfirmed pasteboard teardown blocks reset redrive until the child actually exits", async () => {
    const rig = harness();
    rig.child.setExitDelay(2_000);
    const operation = rig.write().then(
      () => undefined,
      (error: unknown) => error,
    );
    await drainUntilQuiescent(rig.timer);
    rig.timer.advanceTime(10_000);
    await drainUntilQuiescent(rig.timer);
    rig.timer.advanceTime(1_000);
    expect(String(await operation)).toContain("unconfirmed");
    await expect(rig.port.assertSettled(rig.context)).rejects.toThrow("unconfirmed");
    rig.timer.advanceTime(1_000);
    await drainUntilQuiescent(rig.timer);
    await rig.port.assertSettled(rig.context);
  });

  test("pasteboard cancellation joins the child and preserves abort instead of successful reset", async () => {
    const rig = harness();
    const operation = rig.write().then(
      () => undefined,
      (error: unknown) => error,
    );
    await drainUntilQuiescent(rig.timer);
    rig.controller.abort(new DOMException("cancelled", "AbortError"));
    rig.timer.advanceTime(0);
    expect(String(await operation)).toContain("cancelled");
    expect(rig.child.signalCode).toBe("SIGTERM");
  });

  test("a missing device-specific automation manager fails the health probe without discovery or creation", async () => {
    expect(
      await nativeIosResetHealth(new FakeTimer()).probe(
        { deviceId: "no-existing-reset-health-manager", name: "phone", platform: "ios" },
        new AbortController().signal,
      ),
    ).toBe(false);
  });
});
