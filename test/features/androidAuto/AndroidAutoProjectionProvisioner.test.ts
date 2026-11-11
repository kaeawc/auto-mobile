import { describe, expect, test } from "bun:test";
import type { AndroidAutoPhone } from "../../../src/features/androidAuto/AndroidAutoPhone";
import {
  AndroidAutoProjectionProvisioner,
  type AndroidAutoProjectionRequest,
} from "../../../src/features/androidAuto/AndroidAutoProjectionProvisioner";
import type { AndroidAutoSignerCheck } from "../../../src/features/androidAuto/AndroidAutoSignerCheck";
import { ActionableError } from "../../../src/models/ActionableError";
import type { AndroidAutoSettingsUi } from "../../../src/features/androidAuto/AndroidAutoSettingsUi";
import type {
  DesktopHeadUnitLauncher,
  DesktopHeadUnitSession,
  DhuLaunchOutcome,
} from "../../../src/features/androidAuto/DesktopHeadUnit";
import { fixedBackoff } from "../../../src/utils/Backoff";
import { FakeTimer } from "../../fakes/FakeTimer";

/** A phone whose provisioning state lives in plain fields; every mutation is recorded. */
class FakePhone implements AndroidAutoPhone {
  readonly changes: string[] = [];
  sideloaded = false;
  keyguardDisabled = false;
  stayOn = false;
  listenerAllowed = false;
  serverListening = false;
  redirected = false;

  constructor(private readonly ui: FakeUi) {}

  async isAndroidAutoSideloaded() {
    return this.sideloaded;
  }
  async installSplitApks(paths: readonly string[]) {
    this.changes.push(`install:${paths.join(",")}`);
    this.sideloaded = true;
  }
  async isKeyguardDisabled() {
    return this.keyguardDisabled;
  }
  async disableKeyguard() {
    this.changes.push("keyguard");
    this.keyguardDisabled = true;
  }
  async isStayOnEnabled() {
    return this.stayOn;
  }
  async enableStayOn() {
    this.changes.push("stay-on");
    this.stayOn = true;
  }
  async isNotificationListenerAllowed() {
    return this.listenerAllowed;
  }
  async allowNotificationListener() {
    this.changes.push("listener");
    this.listenerAllowed = true;
  }
  async isHeadUnitServerListening() {
    return this.serverListening || this.ui.serverStarted;
  }
  async openAndroidAutoSettings() {}
  async forceStopAndroidAuto() {
    this.changes.push("force-stop");
    this.ui.serverStarted = false;
    this.serverListening = false;
  }
  async addHeadUnitRedirect() {
    this.changes.push("redirect");
    this.redirected = true;
  }
}

class FakeUi implements AndroidAutoSettingsUi {
  readonly changes: string[] = [];
  developerMode = false;
  unknownSources = false;
  serverStarted = false;
  onboardingPending = false;

  async isDeveloperModeEnabled() {
    return this.developerMode;
  }
  async enableDeveloperMode() {
    this.changes.push("developer-mode");
    this.developerMode = true;
  }
  async isUnknownSourcesEnabled() {
    return this.unknownSources;
  }
  async enableUnknownSources() {
    this.changes.push("unknown-sources");
    this.unknownSources = true;
  }
  async startHeadUnitServer() {
    this.changes.push("start-server");
    this.serverStarted = true;
  }
  async isOnboardingPending() {
    return this.onboardingPending;
  }
  async acceptOnboarding() {
    this.changes.push("onboarding");
    this.onboardingPending = false;
  }
}

class FakeSession implements DesktopHeadUnitSession {
  running = true;
  sendCommand() {}
  isRunning() {
    return this.running;
  }
  async stop() {
    this.running = false;
  }
}

class FakeLauncher implements DesktopHeadUnitLauncher {
  launches = 0;
  constructor(private readonly outcomes: DhuLaunchOutcome[] = []) {}
  async launch(): Promise<DhuLaunchOutcome> {
    this.launches++;
    return this.outcomes.shift() ?? { status: "connected", session: new FakeSession() };
  }
}

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
  const provisioner = new AndroidAutoProjectionProvisioner({
    phone,
    ui,
    signerCheck: signerCheck ?? {
      verify: async (paths) => {
        verified.push([...paths]);
      },
    },
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
    expect(second).toBe(first);
  });

  test("refuses another device while a run is in flight", async () => {
    const { provisioner } = setup();
    const first = provisioner.provision(request());
    await expect(provisioner.provision(request({ deviceId: "emulator-5556" }))).rejects.toThrow(
      "is in progress",
    );
    await first;
  });
});
