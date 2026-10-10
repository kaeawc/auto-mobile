import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import * as processLifecycle from "../../src/processLifecycle";
import { FakeDeviceSessionRepository } from "../fakes/FakeDeviceSessionRepository";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";

// #11156: a terminal-attached daemon died on SIGHUP without cleanup. Daemon
// mode must route hangup through the same graceful shutdown as SIGTERM.

interface DaemonShutdownWiring {
  setupShutdownHandlers(): void;
}

describe("Daemon hangup shutdown wiring (#11156)", () => {
  const restores: Array<() => void> = [];

  afterEach(() => {
    for (const restore of restores.splice(0).reverse()) {
      restore();
    }
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
  });

  test("daemon shutdown handlers include SIGHUP", () => {
    const daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      new FakeTimer(),
      new FakeDeviceSessionRepository(),
    );
    const hangup = spyOn(processLifecycle, "installHangupShutdownHandler").mockImplementation(
      () => {},
    );
    for (const spy of [
      hangup,
      spyOn(processLifecycle, "installProcessLifecycleHandlers").mockImplementation(() => {}),
      spyOn(processLifecycle, "setProcessShutdownHandler").mockImplementation(() => {}),
      spyOn(processLifecycle, "setFatalProcessHandler").mockImplementation(() => {}),
      spyOn(process, "once").mockImplementation(() => process),
    ]) {
      restores.push(() => spy.mockRestore());
    }

    (daemon as unknown as DaemonShutdownWiring).setupShutdownHandlers();

    expect(hangup).toHaveBeenCalledTimes(1);
  });
});
