import { describe, expect, test } from "bun:test";
import {
  AndroidAutoProjectionProvisioner,
  type AndroidAutoProjectionRequest,
} from "../../../src/features/androidAuto/AndroidAutoProjectionProvisioner";
import type { AndroidAutoSignerCheck } from "../../../src/features/androidAuto/AndroidAutoSignerCheck";
import { ActionableError } from "../../../src/models/ActionableError";
import type { DhuLaunchOutcome } from "../../../src/features/androidAuto/DesktopHeadUnit";
import { fixedBackoff } from "../../../src/utils/Backoff";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  FakeLauncher,
  FakePhone,
  FakeSession,
  FakeUi,
} from "../../fakes/FakeAndroidAutoProjection";

function setup(
  outcomes: DhuLaunchOutcome[] = [],
  signerCheck?: AndroidAutoSignerCheck,
  portHeldElsewhere = false,
) {
  const ui = new FakeUi();
  const phone = new FakePhone(ui);
  const verified: string[][] = [];
  const launcher = new FakeLauncher(outcomes);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const signers: AndroidAutoSignerCheck = signerCheck ?? {
    verify: async (paths) => {
      verified.push([...paths]);
    },
  };
  const provisioner = new AndroidAutoProjectionProvisioner({
    forDevice: () => ({ phone, ui, signerCheck: signers }),
    dhu: launcher,
    hostPorts: { isPortAvailable: () => !phone.redirected && !portHeldElsewhere },
    timer,
    recoveryBackoff: fixedBackoff(1_000),
  });
  return { ui, phone, verified, launcher, timer, provisioner };
}

const APKS = ["/apks/base.apk", "/apks/split_config.arm64_v8a.apk"];

function request(
  overrides: Partial<AndroidAutoProjectionRequest> = {},
): AndroidAutoProjectionRequest {
  return {
    deviceId: "emulator-5554",
    androidAutoApks: APKS,
    dhu: { binaryPath: "desktop-head-unit", configPath: "config/default_720p.ini" },
    ...overrides,
  };
}

describe("AndroidAutoProjectionProvisioner", () => {
  test("provisions a fresh Play emulator in the order verified on device", async () => {
    const { ui, phone, verified, launcher, provisioner } = setup();
    const result = await provisioner.provision(request());
    expect(result.steps.map((step) => `${step.step}:${step.status}`)).toEqual([
      "android-auto-apk:applied",
      "keyguard:applied",
      "stay-awake:applied",
      "notification-access:applied",
      "developer-mode:applied",
      "unknown-sources:applied",
      "head-unit-server:applied",
      "transport:applied",
      "desktop-head-unit:applied",
      "onboarding:already-done",
    ]);
    expect(verified).toEqual([APKS]);
    expect(phone.changes).toEqual([
      `install:${APKS.join(",")}`,
      "keyguard",
      "stay-on",
      "listener",
      "redirect",
    ]);
    expect(ui.changes).toEqual(["developer-mode", "unknown-sources", "start-server"]);
    expect(launcher.launches).toBe(1);
    expect(result.session.isRunning()).toBe(true);
  });

  test("a rerun on a provisioned phone changes nothing and reuses the running DHU", async () => {
    const { ui, phone, launcher, provisioner } = setup();
    const first = await provisioner.provision(request());
    const phoneChanges = phone.changes.length;
    const uiChanges = ui.changes.length;

    const second = await provisioner.provision(request());
    expect(second.steps.every((step) => step.status === "already-done")).toBe(true);
    expect(phone.changes).toHaveLength(phoneChanges);
    expect(ui.changes).toHaveLength(uiChanges);
    expect(launcher.launches).toBe(1);
    expect(second.session).toBe(first.session);
  });

  test("waits for a just-booted phone that adb still reports offline before the APK steps", async () => {
    const statesAtVerify: number[] = [];
    const { phone, timer, provisioner } = setup([], {
      verify: async () => {
        statesAtVerify.push(phone.adbStateChecks);
      },
    });
    phone.adbStates = ["error: device offline", "offline", "device"];
    const result = await provisioner.provision(request());
    expect(result.steps[0]).toEqual({
      step: "android-auto-apk",
      status: "applied",
      detail: "installed 2 APKs",
    });
    expect(statesAtVerify).toEqual([3]);
    expect(timer.getSleepHistory()).toEqual([500, 1_000]);
  });

  test("a phone that stays offline fails with an actionable error having changed nothing", async () => {
    const { phone, ui, verified, timer, provisioner } = setup();
    phone.adbStates = ["error: device offline"];
    const failure = provisioner.provision(request());
    await expect(failure).rejects.toBeInstanceOf(ActionableError);
    await expect(failure).rejects.toThrow(
      "adb still reports emulator-5554 as not ready (error: device offline) after 60 s",
    );
    expect(timer.getSleepHistory().reduce((sum, ms) => sum + ms, 0)).toBe(60_000);
    expect(verified).toEqual([]);
    expect(phone.changes).toEqual([]);
    expect(ui.changes).toEqual([]);
  });

  test("the provision deadline's abort ends the offline wait", async () => {
    const { phone, provisioner } = setup();
    const controller = new AbortController();
    phone.adbStates = ["offline"];
    const adbState = phone.adbState.bind(phone);
    phone.adbState = async () => {
      if (phone.adbStateChecks === 2) {
        controller.abort(new Error("provision deadline"));
      }
      return adbState();
    };
    await expect(provisioner.provision(request({ signal: controller.signal }))).rejects.toThrow(
      "provision deadline",
    );
    expect(phone.adbStateChecks).toBe(3);
    expect(phone.changes).toEqual([]);
  });

  test("a phone still on the stub with no APKs supplied fails without touching it", async () => {
    const { phone, provisioner } = setup();
    await expect(provisioner.provision(request({ androidAutoApks: [] }))).rejects.toThrow(
      "never downloads them",
    );
    expect(phone.changes).toEqual([]);
  });

  test("a signer mismatch stops before the install", async () => {
    const { phone, provisioner } = setup([], {
      verify: async () => {
        throw new ActionableError("base.apk is signed by another key");
      },
    });
    await expect(provisioner.provision(request())).rejects.toThrow("signed by another key");
    expect(phone.changes).toEqual([]);
  });

  test("relaunches after a stall by force-stopping Android Auto and restarting its server", async () => {
    const { ui, phone, launcher, provisioner } = setup([
      { status: "stalled", detail: "2 Ping timeout lines" },
    ]);
    const result = await provisioner.provision(request());
    expect(launcher.launches).toBe(2);
    expect(phone.changes).toContain("force-stop");
    expect(ui.changes.filter((change) => change === "start-server")).toHaveLength(2);
    expect(result.steps.find((step) => step.step === "desktop-head-unit")?.detail).toBe(
      "connected after 1 relaunches",
    );
  });

  test("a relaunch waits for the restarted head unit server to bind", async () => {
    const { ui, phone, launcher, timer, provisioner } = setup([
      { status: "stalled", detail: "2 Ping timeout lines" },
    ]);
    let checksAfterRestart = 0;
    const listening = phone.isHeadUnitServerListening.bind(phone);
    phone.isHeadUnitServerListening = async () => {
      if (!phone.changes.includes("force-stop")) {
        return listening();
      }
      checksAfterRestart++;
      return ui.serverStarted && checksAfterRestart >= 3;
    };
    const checksAtLaunch: number[] = [];
    const launch = launcher.launch.bind(launcher);
    launcher.launch = async () => {
      checksAtLaunch.push(checksAfterRestart);
      return launch();
    };
    await provisioner.provision(request());
    expect(checksAtLaunch).toEqual([0, 3]);
    expect(timer.getSleepHistory()).toEqual([1_000, 250, 500]);
  });

  test("a restarted server that never binds fails that attempt without a relaunch", async () => {
    const stall: DhuLaunchOutcome = { status: "stalled", detail: "2 Ping timeout lines" };
    const { ui, launcher, provisioner } = setup([stall]);
    const start = ui.startHeadUnitServer.bind(ui);
    let starts = 0;
    ui.startHeadUnitServer = async () => {
      starts++;
      // Only the initial start binds; every recovery restart leaves the port unbound.
      if (starts === 1) {
        await start();
      }
    };
    await expect(provisioner.provision(request())).rejects.toThrow(
      "head-unit-server: not listening on port 5277 after the restart",
    );
    expect(launcher.launches).toBe(1);
  });

  test("stops an unhealthy session before relaunching so it cannot orphan a DHU", async () => {
    const unhealthy = new FakeSession();
    let stops = 0;
    unhealthy.stop = async () => {
      stops++;
    };
    const { launcher, provisioner } = setup([{ status: "connected", session: unhealthy }]);
    await provisioner.provision(request());
    unhealthy.running = false;
    const second = await provisioner.provision(request());
    expect(stops).toBe(1);
    expect(launcher.launches).toBe(2);
    expect(second.session).not.toBe(unhealthy);
  });

  test("does not relaunch next to an unhealthy DHU that never exits", async () => {
    const stuck = new FakeSession();
    stuck.stop = async () => {
      throw new ActionableError("The Desktop Head Unit did not exit");
    };
    const { launcher, provisioner } = setup([{ status: "connected", session: stuck }]);
    await provisioner.provision(request());
    stuck.running = false;
    await expect(provisioner.provision(request())).rejects.toThrow("did not exit");
    expect(launcher.launches).toBe(1);
  });

  test("tracks a failed launch's DHU that survives SIGKILL so another device is refused", async () => {
    const zombie = new FakeSession();
    zombie.running = false;
    let stops = 0;
    zombie.stop = async () => {
      stops++;
      throw new ActionableError("The Desktop Head Unit did not exit");
    };
    const { phone, launcher, provisioner } = setup([
      { status: "unkillable", detail: "no-connect: no connected.; did not exit", session: zombie },
    ]);
    const failed = provisioner.provision(request());
    await expect(failed).rejects.toBeInstanceOf(ActionableError);
    await expect(failed).rejects.toThrow("did not exit after SIGTERM and SIGKILL");
    expect(launcher.launches).toBe(1);

    phone.redirected = false;
    await expect(provisioner.provision(request({ deviceId: "emulator-5556" }))).rejects.toThrow(
      "for emulator-5554 is unhealthy but still running",
    );
    expect(launcher.launches).toBe(1);

    // Re-provisioning the same device retries the stop and still refuses to relaunch beside it.
    await expect(provisioner.provision(request())).rejects.toThrow("did not exit");
    expect(stops).toBe(1);
    expect(launcher.launches).toBe(1);
  });

  test("launches again once a tracked unkillable DHU finally exits", async () => {
    const zombie = new FakeSession();
    zombie.running = false;
    const { phone, launcher, provisioner } = setup([
      { status: "unkillable", detail: "stalled: exited; did not exit", session: zombie },
    ]);
    await expect(provisioner.provision(request())).rejects.toThrow("still holds host port 5277");
    zombie.alive = false;
    phone.redirected = false;
    const result = await provisioner.provision(request({ deviceId: "emulator-5556" }));
    expect(result.session.isRunning()).toBe(true);
    expect(launcher.launches).toBe(2);
  });

  test("a failure after this run started its DHU stops that DHU so other devices are not blocked", async () => {
    const launched = new FakeSession();
    let stops = 0;
    const stop = launched.stop.bind(launched);
    launched.stop = async () => {
      stops++;
      await stop();
    };
    const { ui, phone, launcher, provisioner } = setup([
      { status: "connected", session: launched },
    ]);
    ui.onboardingPending = true;
    ui.isOnboardingPending = async () => {
      throw new ActionableError("uiautomator dump failed");
    };
    await expect(provisioner.provision(request())).rejects.toThrow("uiautomator dump failed");
    expect(stops).toBe(1);

    phone.redirected = false;
    ui.isOnboardingPending = async () => false;
    const other = await provisioner.provision(request({ deviceId: "emulator-5556" }));
    expect(other.session.isRunning()).toBe(true);
    expect(launcher.launches).toBe(2);
  });

  test("a failed run's DHU that will not stop stays tracked and keeps blocking other devices", async () => {
    const stuck = new FakeSession();
    stuck.stop = async () => {
      stuck.running = false;
      throw new ActionableError("The Desktop Head Unit did not exit");
    };
    const { ui, phone, provisioner } = setup([{ status: "connected", session: stuck }]);
    ui.isOnboardingPending = async () => {
      throw new ActionableError("uiautomator dump failed");
    };
    await expect(provisioner.provision(request())).rejects.toThrow("uiautomator dump failed");
    phone.redirected = false;
    await expect(provisioner.provision(request({ deviceId: "emulator-5556" }))).rejects.toThrow(
      "for emulator-5554 is unhealthy but still running",
    );
  });

  test("a failed rerun does not stop a DHU an earlier run started", async () => {
    const first = new FakeSession();
    let stops = 0;
    first.stop = async () => {
      stops++;
    };
    const { ui, provisioner } = setup([{ status: "connected", session: first }]);
    await provisioner.provision(request());
    ui.isOnboardingPending = async () => {
      throw new ActionableError("uiautomator dump failed");
    };
    await expect(provisioner.provision(request())).rejects.toThrow("uiautomator dump failed");
    expect(stops).toBe(0);
    expect(first.isRunning()).toBe(true);
  });

  test("gives up after the recovery budget with every attempt's reason", async () => {
    const stall: DhuLaunchOutcome = { status: "no-connect", detail: "no connected." };
    const { launcher, provisioner } = setup([stall, stall, stall]);
    await expect(provisioner.provision(request())).rejects.toThrow("after 3 attempts");
    expect(launcher.launches).toBe(3);
  });

  test("reports a pending welcome screen without accepting Android Auto's terms", async () => {
    const { ui, provisioner } = setup();
    ui.onboardingPending = true;
    const result = await provisioner.provision(request());
    expect(result.steps.at(-1)).toMatchObject({ step: "onboarding", status: "skipped" });
    expect(ui.changes).not.toContain("onboarding");
  });

  test("accepts the welcome screen only on explicit instruction", async () => {
    const { ui, provisioner } = setup();
    ui.onboardingPending = true;
    const result = await provisioner.provision(request({ acceptAndroidAutoTerms: true }));
    expect(result.steps.at(-1)).toMatchObject({ step: "onboarding", status: "applied" });
    expect(ui.changes).toContain("onboarding");
  });

  test("a head unit server that never listens is an actionable error after the bounded wait", async () => {
    const { ui, timer, provisioner } = setup();
    ui.startHeadUnitServer = async () => {};
    await expect(provisioner.provision(request())).rejects.toThrow("not listening on port 5277");
    expect(timer.getSleepHistory()).toEqual([250, 500, 1_000, 2_000, 2_000]);
  });

  test("waits for a head unit server that binds after Start head unit server", async () => {
    const { ui, phone, timer, provisioner } = setup();
    let checksAfterStart = 0;
    const listening = phone.isHeadUnitServerListening.bind(phone);
    phone.isHeadUnitServerListening = async () => {
      if (!ui.serverStarted) {
        return listening();
      }
      checksAfterStart++;
      return checksAfterStart >= 3;
    };
    const result = await provisioner.provision(request());
    expect(result.steps.find((step) => step.step === "head-unit-server")).toMatchObject({
      status: "applied",
    });
    expect(timer.getSleepHistory().slice(0, 2)).toEqual([250, 500]);
  });

  test("refuses a second projecting emulator on the same host", async () => {
    const { provisioner } = setup();
    await provisioner.provision(request());
    await expect(provisioner.provision(request({ deviceId: "emulator-5556" }))).rejects.toThrow(
      "only one emulator per host",
    );
  });

  test("refuses another device while one device's unhealthy DHU is still alive", async () => {
    const unhealthy = new FakeSession();
    let stops = 0;
    unhealthy.stop = async () => {
      stops++;
    };
    const { launcher, provisioner } = setup([{ status: "connected", session: unhealthy }]);
    await provisioner.provision(request());
    unhealthy.running = false;
    const refused = provisioner.provision(request({ deviceId: "emulator-5556" }));
    await expect(refused).rejects.toBeInstanceOf(ActionableError);
    await expect(refused).rejects.toThrow("for emulator-5554 is unhealthy but still running");
    expect(stops).toBe(0);
    expect(launcher.launches).toBe(1);
  });

  test("provisions another device once the first device's DHU has exited", async () => {
    const first = new FakeSession();
    const { phone, launcher, provisioner } = setup([{ status: "connected", session: first }]);
    await provisioner.provision(request());
    first.running = false;
    first.alive = false;
    // The first emulator is gone, taking its host port 5277 redirect with it.
    phone.redirected = false;
    const second = await provisioner.provision(request({ deviceId: "emulator-5556" }));
    expect(second.session).not.toBe(first);
    expect(second.steps.find((step) => step.step === "transport")).toMatchObject({
      status: "applied",
    });
    expect(launcher.launches).toBe(2);
  });

  test("refuses a host port 5277 it did not redirect to this device", async () => {
    const { phone, launcher, provisioner } = setup([], undefined, true);
    await expect(provisioner.provision(request())).rejects.toThrow(
      "a redirect or process AutoMobile did not create",
    );
    expect(phone.changes).not.toContain("redirect");
    expect(launcher.launches).toBe(0);
  });

  test("concurrent calls for one device share a single run and DHU launch", async () => {
    const { launcher, provisioner } = setup();
    const [first, second] = await Promise.all([
      provisioner.provision(request()),
      provisioner.provision(request()),
    ]);
    expect(launcher.launches).toBe(1);
    expect(second.session).toBe(first.session);
    // Only the call that ran the launch owns the DHU; the joiner never stops it on its own timeout.
    expect(first.steps.find((step) => step.step === "desktop-head-unit")?.status).toBe("applied");
    expect(second.steps.find((step) => step.step === "desktop-head-unit")).toEqual({
      step: "desktop-head-unit",
      status: "already-done",
      detail: "joined the run in progress",
    });
  });

  test("a reused DHU reports the config it was launched with, not the latest request's", async () => {
    const { launcher, provisioner } = setup();
    const first = await provisioner.provision(request());
    const second = await provisioner.provision(
      request({ dhu: { binaryPath: "desktop-head-unit", configPath: "config/default_1080p.ini" } }),
    );
    expect(launcher.launches).toBe(1);
    expect(first.configPath).toBe("config/default_720p.ini");
    expect(second.configPath).toBe("config/default_720p.ini");
    expect(second.steps.find((step) => step.step === "desktop-head-unit")?.detail).toBe(
      "reused the running DHU, started with config/default_720p.ini; killDevice stops it so one can start with config/default_1080p.ini",
    );
  });

  test("refuses another device while a run is in flight", async () => {
    const { provisioner } = setup();
    const first = provisioner.provision(request());
    await expect(provisioner.provision(request({ deviceId: "emulator-5556" }))).rejects.toThrow(
      "is in progress",
    );
    await first;
  });

  test("stopDesktopHeadUnit stops the spawned DHU, so a reused serial launches its own", async () => {
    const first = new FakeSession();
    let stops = 0;
    const stop = first.stop.bind(first);
    first.stop = async () => {
      stops++;
      await stop();
    };
    const { phone, launcher, provisioner } = setup([{ status: "connected", session: first }]);
    await provisioner.provision(request());

    await provisioner.stopDesktopHeadUnit("emulator-5554", { deviceStopped: true });
    expect(stops).toBe(1);
    // The emulator and its redirect are gone; a new emulator takes the same serial.
    phone.redirected = false;
    const again = await provisioner.provision(request());
    const status = (name: string) => again.steps.find((step) => step.step === name)?.status;
    expect(status("desktop-head-unit")).toBe("applied");
    expect(status("transport")).toBe("applied");
    expect(launcher.launches).toBe(2);
    expect(again.session).not.toBe(first);
  });

  test("stopDesktopHeadUnit after a failed provision frees the host for another device", async () => {
    const { phone, provisioner } = setup();
    await provisioner.provision(request());
    await provisioner.stopDesktopHeadUnit("emulator-5554");
    phone.redirected = false;
    const other = await provisioner.provision(request({ deviceId: "emulator-5556" }));
    expect(other.session.isRunning()).toBe(true);
  });

  test("stopDesktopHeadUnit without deviceStopped keeps the redirect, so the same emulator re-provisions", async () => {
    const { launcher, provisioner } = setup();
    await provisioner.provision(request());
    // A kill that failed after the DHU stopped: the emulator and its redirect are still there.
    await provisioner.stopDesktopHeadUnit("emulator-5554");
    const again = await provisioner.provision(request());
    const status = (name: string) => again.steps.find((step) => step.step === name)?.status;
    expect(status("transport")).toBe("already-done");
    expect(status("desktop-head-unit")).toBe("applied");
    expect(launcher.launches).toBe(2);
  });

  test("refusing another device names killDevice or re-provisioning as the recovery", async () => {
    const { phone, provisioner } = setup();
    await provisioner.provision(request());
    phone.redirected = false;
    await expect(provisioner.provision(request({ deviceId: "emulator-5556" }))).rejects.toThrow(
      "Call killDevice on emulator-5554 (which stops its DHU), or re-provision emulator-5554",
    );
  });

  test("stopDesktopHeadUnit never touches a DHU it did not spawn for that device", async () => {
    const first = new FakeSession();
    let stops = 0;
    first.stop = async () => {
      stops++;
    };
    const { provisioner } = setup([{ status: "connected", session: first }]);
    await provisioner.provision(request());
    await provisioner.stopDesktopHeadUnit("emulator-5556", { deviceStopped: true });
    expect(stops).toBe(0);
    expect(first.isRunning()).toBe(true);
  });

  test("a DHU whose stop fails stays tracked but is never reused as already-done", async () => {
    const stuck = new FakeSession();
    let stops = 0;
    stuck.stop = async () => {
      stops++;
      if (stops === 1) {
        throw new ActionableError("The Desktop Head Unit did not exit");
      }
      stuck.running = false;
      stuck.alive = false;
    };
    const { phone, launcher, provisioner } = setup([{ status: "connected", session: stuck }]);
    await provisioner.provision(request());
    await provisioner.stopDesktopHeadUnit("emulator-5554");
    // Still alive, so another device is refused...
    phone.redirected = false;
    await expect(provisioner.provision(request({ deviceId: "emulator-5556" }))).rejects.toThrow(
      "is already projecting emulator-5554",
    );
    // ...and the same serial retries the stop and launches a fresh DHU instead of reusing it.
    const again = await provisioner.provision(request());
    expect(stops).toBe(2);
    expect(again.session).not.toBe(stuck);
    expect(launcher.launches).toBe(2);
  });
});
