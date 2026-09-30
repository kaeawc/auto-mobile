import { expect, spyOn, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import { FakeTimer } from "../fakes/FakeTimer";

test("an iOS runner supervisor restart starts only its own device", async () => {
  const timer = new FakeTimer();
  const deviceX: BootedDevice = { deviceId: "sim-x", name: "iPhone X", platform: "ios" };
  const deviceY: BootedDevice = { deviceId: "sim-y", name: "iPhone Y", platform: "ios" };
  const managerX = IOSCtrlProxyManager.createForTestingWithDeps(
    deviceX,
    timer,
    undefined,
    new FakeProcessExecutor(),
  );
  const managerY = IOSCtrlProxyManager.createForTestingWithDeps(
    deviceY,
    timer,
    undefined,
    new FakeProcessExecutor(),
  );
  const supervisorX = (
    managerX as unknown as {
      processSupervisor: { start(): Promise<void>; processExited(): void; stop(): void };
    }
  ).processSupervisor;
  const startX = spyOn(managerX, "start").mockResolvedValue();
  const startY = spyOn(managerY, "start").mockResolvedValue();
  try {
    await supervisorX.start();
    supervisorX.processExited();
    await Promise.resolve();
    await timer.advanceTimeAsync(2_000);
    expect(startX).toHaveBeenCalledTimes(1);
    expect(startY).not.toHaveBeenCalled();
  } finally {
    supervisorX.stop();
    startX.mockRestore();
    startY.mockRestore();
  }
});
