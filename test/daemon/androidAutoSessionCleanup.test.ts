import { describe, expect, test } from "bun:test";
import { registerAndroidAutoSessionCleanup } from "../../src/daemon/androidAutoSessionCleanup";
import { getAbortSignal, runWithAbortSignal } from "../../src/utils/AbortContext";
import {
  AndroidAutoProjectionProvisioner,
  type AndroidAutoProjectionRequest,
} from "../../src/features/androidAuto/AndroidAutoProjectionProvisioner";
import type { DhuLaunchOutcome } from "../../src/features/androidAuto/DesktopHeadUnit";
import { fixedBackoff } from "../../src/utils/Backoff";
import { FakeLauncher, FakePhone, FakeSession, FakeUi } from "../fakes/FakeAndroidAutoProjection";
import {
  FakeSessionCleanupManager,
  type FakeSessionCleanupManagerOptions,
} from "../fakes/FakeSessionCleanupManager";
import { FakeTimer } from "../fakes/FakeTimer";

const PHONE = "emulator-5554";
const OTHER_PHONE = "emulator-5556";

function setup(
  outcomes: DhuLaunchOutcome[] = [],
  managerOptions: FakeSessionCleanupManagerOptions = {},
) {
  const ui = new FakeUi();
  const phone = new FakePhone(ui);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const provisioner = new AndroidAutoProjectionProvisioner({
    forDevice: () => ({ phone, ui, signerCheck: { verify: async () => {} } }),
    dhu: new FakeLauncher(outcomes),
    // The phone's redirect is what binds host port 5277.
    hostPorts: { isPortAvailable: () => !phone.redirected },
    timer,
    recoveryBackoff: fixedBackoff(1_000),
  });
  const manager = new FakeSessionCleanupManager(managerOptions);
  registerAndroidAutoSessionCleanup(manager, () => provisioner);
  return { phone, provisioner, manager };
}

function request(deviceId = PHONE): AndroidAutoProjectionRequest {
  return {
    deviceId,
    androidAutoApks: ["/apks/base.apk"],
    dhu: { binaryPath: "desktop-head-unit", configPath: "config/default_720p.ini" },
  };
}

async function expectHostPortFree(h: ReturnType<typeof setup>): Promise<void> {
  expect(h.phone.redirected).toBe(false);
  const other = await h.provisioner.provision(request(OTHER_PHONE));
  expect(other.steps.find((step) => step.step === "transport")?.status).toBe("applied");
  expect(other.session.isRunning()).toBe(true);
}

describe("registerAndroidAutoSessionCleanup", () => {
  test("a release stops the session's DHU and removes its redirect, freeing port 5277", async () => {
    const dhu = new FakeSession();
    const h = setup([{ status: "connected", session: dhu }]);
    await h.provisioner.provision(request());

    h.manager.release("s-1", PHONE);
    expect(h.manager.pendingCleanups.map(({ deviceId, bound }) => [deviceId, bound])).toEqual([
      [PHONE, { name: "stop the Android Auto Desktop Head Unit", leftover: expect.any(String) }],
    ]);
    await h.manager.settle();

    expect(dhu.isAlive()).toBe(false);
    expect(h.phone.changes).toContain("redirect-removed");
    await expectHostPortFree(h);
  });

  test("a release inside a cancelled request still removes the redirect", async () => {
    const h = setup();
    await h.provisioner.provision(request());
    // A real adb call combines the ambient request signal; the fake reads it the same way.
    h.phone.removeHeadUnitRedirect = async () => {
      getAbortSignal()?.throwIfAborted();
      h.phone.redirected = false;
    };
    const cancelled = new AbortController();
    cancelled.abort(new Error("Operation cancelled"));

    await runWithAbortSignal(cancelled.signal, async () => h.manager.release("s-1", PHONE));
    await h.manager.settle();

    await expectHostPortFree(h);
  });

  test("a heartbeat reap frees port 5277 the same way", async () => {
    const dhu = new FakeSession();
    const h = setup([{ status: "connected", session: dhu }], {
      releaseReason: "heartbeat-timeout",
    });
    await h.provisioner.provision(request());

    h.manager.release("s-1", PHONE);
    await h.manager.settle();

    expect(dhu.isAlive()).toBe(false);
    await expectHostPortFree(h);
  });

  test("a phone another live session still holds keeps its DHU and port 5277", async () => {
    const dhu = new FakeSession();
    const h = setup([{ status: "connected", session: dhu }]);
    await h.provisioner.provision(request());
    h.manager.holders.set(PHONE, "s-2");

    h.manager.release("s-1", PHONE);
    await h.manager.settle();

    expect(h.manager.pendingCleanups).toEqual([]);
    expect(dhu.isRunning()).toBe(true);
    expect(h.phone.redirected).toBe(true);
  });

  test("a phone this daemon never projected is left alone", async () => {
    const dhu = new FakeSession();
    const h = setup([{ status: "connected", session: dhu }]);
    await h.provisioner.provision(request());

    h.manager.release("s-1", OTHER_PHONE);

    expect(h.manager.pendingCleanups).toEqual([]);
    expect(dhu.isRunning()).toBe(true);
    expect(h.phone.changes).not.toContain("redirect-removed");
  });

  test("a terminal upgrade of a finished release does nothing", async () => {
    const dhu = new FakeSession();
    const h = setup([{ status: "connected", session: dhu }]);
    await h.provisioner.provision(request());

    h.manager.release("s-1", PHONE, true);

    expect(h.manager.pendingCleanups).toEqual([]);
    expect(dhu.isRunning()).toBe(true);
  });

  test("a replaced serial stops the old DHU without holding up the new device", async () => {
    const dhu = new FakeSession();
    const h = setup([{ status: "connected", session: dhu }]);
    await h.provisioner.provision(request());

    h.manager.release("s-1", PHONE, false, true);
    await Promise.resolve();

    expect(h.manager.pendingCleanups).toEqual([]);
    expect(dhu.isAlive()).toBe(false);
    // The old emulator took its redirect with it; no command reaches the new one.
    expect(h.phone.changes).not.toContain("redirect-removed");
    expect(h.provisioner.holdsHostPortFor(PHONE)).toBe(false);
  });

  test("a DHU that will not stop keeps the redirect, so the refusal still names the phone", async () => {
    const stuck = new FakeSession();
    stuck.stop = async () => {
      throw new Error("The Desktop Head Unit did not exit");
    };
    const h = setup([{ status: "connected", session: stuck }]);
    await h.provisioner.provision(request());

    h.manager.release("s-1", PHONE);
    await h.manager.settle();

    expect(h.phone.redirected).toBe(true);
    expect(h.provisioner.holdsHostPortFor(PHONE)).toBe(true);
  });
});
