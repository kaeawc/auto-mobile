import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import * as path from "path";
import {
  AndroidCtrlProxyManager,
  REBIND_BIND_WAIT_BUDGET_MS,
} from "../../src/ctrlProxy/CtrlProxyManager";
import type { BootedDevice } from "../../src/models";
import { createExecResult } from "../../src/utils/execResult";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { useFakeCtrlProxyManagerHost } from "../helpers/ctrlProxyManagerHost";

// Captured on an API 27 google_apis arm64 emulator (1 core, 1536 MB). API 27 prints only
// `services:{...}` (the bound services) per user, with no Enabled/Binding/Crashed sections.
const fixture = (name: string) =>
  readFileSync(path.join(import.meta.dir, `../fixtures/ctrlproxy/${name}`), "utf8");
const api27Bound = fixture("accessibility-api27-bound.txt");
const api27Unbound = fixture("accessibility-api27-unbound.txt");

const PACKAGE = AndroidCtrlProxyManager.PACKAGE;
const COMPONENT = `${PACKAGE}/${PACKAGE}.CtrlProxy`;
const DUMPSYS = "shell dumpsys accessibility";
const ENABLED_SETTING = "settings get secure enabled_accessibility_services";
const FORCE_STOP = `shell am force-stop ${PACKAGE}`;

describe("CtrlProxy health on API 27 dumpsys (#18981)", () => {
  useFakeCtrlProxyManagerHost();
  let adb: FakeAdbExecutor;
  let timer: FakeTimer;
  let manager: AndroidCtrlProxyManager;

  beforeEach(() => {
    AndroidCtrlProxyManager.resetInstances();
    adb = new FakeAdbExecutor();
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    const device: BootedDevice = { deviceId: "emulator-5600", platform: "android", name: "api27" };
    manager = AndroidCtrlProxyManager.createForTestingWithDeps(device, adb, { timer });
    adb.setCommandResponse(ENABLED_SETTING, createExecResult(COMPONENT, ""));
  });

  const forceStops = () => adb.getExecutedCommands().filter((command) => command === FORCE_STOP);

  test("a bound service is healthy and is not rebound", async () => {
    adb.setCommandResponse(DUMPSYS, createExecResult(api27Bound, ""));

    expect(await manager.isAccessibilityServiceHealthy()).toBe(true);
    expect(await manager.rebindIfUnhealthy()).toBe(false);
    expect(forceStops()).toHaveLength(0);
  });

  test("a slow cold start is waited out with no force-stop (mt0100a timeline)", async () => {
    // Enabled at t=0; the service binds about 23 s later on the constrained emulator.
    // Before the fix both readiness and observe recovery read "absent", force-stopped
    // within a second of each other, and escalated to a full setup.
    adb.setCommandResponseSequence(DUMPSYS, [
      ...Array.from({ length: 16 }, () => createExecResult(api27Unbound, "")),
      createExecResult(api27Bound, ""),
    ]);

    expect(await manager.isAccessibilityServiceHealthy()).toBe(false);
    // Readiness check right after enable: the service is starting, so no rebind.
    expect(await manager.rebindIfUnhealthy()).toBe(false);
    // Observe recovery about 1 s later: still starting, so it waits instead.
    timer.advanceTime(1_000);
    expect(await manager.rebindIfUnhealthy()).toBe(false);
    expect(await manager.waitForAccessibilityServiceBinding()).toBe("recovered");

    expect(await manager.isAccessibilityServiceHealthy()).toBe(true);
    expect(forceStops()).toHaveLength(0);
    expect(timer.now()).toBeGreaterThan(10_000);
    expect(timer.now()).toBeLessThan(REBIND_BIND_WAIT_BUDGET_MS);
  });

  test("a service that never binds is rebound once the bind grace ends", async () => {
    adb.setCommandResponse(DUMPSYS, createExecResult(api27Unbound, ""));

    expect(await manager.rebindIfUnhealthy()).toBe(false);
    timer.advanceTime(REBIND_BIND_WAIT_BUDGET_MS + 1);
    expect(await manager.rebindIfUnhealthy()).toBe(true);
    expect(forceStops()).toHaveLength(1);
  });

  test("a service missing from the enabled setting is rebound immediately", async () => {
    adb.setCommandResponse(DUMPSYS, createExecResult(api27Unbound, ""));
    adb.setCommandResponseSequence(ENABLED_SETTING, [
      createExecResult("null", ""),
      createExecResult("null", ""),
      createExecResult(COMPONENT, ""),
    ]);

    expect(await manager.isAccessibilityServiceHealthy()).toBe(false);
    expect(await manager.rebindIfUnhealthy()).toBe(true);
    expect(forceStops()).toHaveLength(1);
  });
});
