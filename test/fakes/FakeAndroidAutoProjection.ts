import type { AndroidAutoPhone } from "../../src/features/androidAuto/AndroidAutoPhone";
import type { AndroidAutoSettingsUi } from "../../src/features/androidAuto/AndroidAutoSettingsUi";
import type {
  DesktopHeadUnitLauncher,
  DesktopHeadUnitSession,
  DhuLaunchOutcome,
} from "../../src/features/androidAuto/DesktopHeadUnit";

/** A phone whose provisioning state lives in plain fields; every mutation is recorded. */
export class FakePhone implements AndroidAutoPhone {
  readonly changes: string[] = [];
  sideloaded = false;
  keyguardDisabled = false;
  stayOn = false;
  listenerAllowed = false;
  serverListening = false;
  redirected = false;
  /** Replies to successive `adbState` calls; the last one repeats. */
  adbStates: string[] = ["device"];
  adbStateChecks = 0;

  constructor(private readonly ui: FakeUi) {}

  async adbState() {
    const state = this.adbStates[Math.min(this.adbStateChecks, this.adbStates.length - 1)];
    this.adbStateChecks++;
    return state ?? "device";
  }

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

export class FakeUi implements AndroidAutoSettingsUi {
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

export class FakeSession implements DesktopHeadUnitSession {
  running = true;
  /** The DHU process has not exited; an unhealthy session can still be alive. */
  alive = true;
  sendCommand() {}
  isRunning() {
    return this.running && this.alive;
  }
  isAlive() {
    return this.alive;
  }
  async stop() {
    this.running = false;
    this.alive = false;
  }
}

export class FakeLauncher implements DesktopHeadUnitLauncher {
  launches = 0;
  constructor(private readonly outcomes: DhuLaunchOutcome[] = []) {}
  async launch(): Promise<DhuLaunchOutcome> {
    this.launches++;
    return this.outcomes.shift() ?? { status: "connected", session: new FakeSession() };
  }
}
