import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { BackoffPolicy } from "../../utils/Backoff";
import type { PortAvailabilityChecker } from "../../utils/PortManager";
import type { Timer } from "../../utils/SystemTimer";
import { HEAD_UNIT_SERVER_PORT } from "./androidAutoProjection";
import type { AndroidAutoPhone } from "./AndroidAutoPhone";
import type { AndroidAutoSettingsUi } from "./AndroidAutoSettingsUi";
import type { AndroidAutoSignerCheck } from "./AndroidAutoSignerCheck";
import type {
  DesktopHeadUnitLauncher,
  DesktopHeadUnitSession,
  DhuLaunchOutcome,
} from "./DesktopHeadUnit";

export type AndroidAutoProvisioningStepName =
  | "android-auto-apk"
  | "keyguard"
  | "stay-awake"
  | "notification-access"
  | "developer-mode"
  | "unknown-sources"
  | "head-unit-server"
  | "transport"
  | "desktop-head-unit"
  | "onboarding";

export interface AndroidAutoProvisioningStep {
  step: AndroidAutoProvisioningStepName;
  /** `already-done` steps made no change, so a rerun on a provisioned phone reports only those. */
  status: "already-done" | "applied" | "skipped";
  detail?: string;
}

export interface AndroidAutoProjectionRequest {
  /** The phone emulator's adb serial; one projecting emulator per host (one host port 5277). */
  deviceId: string;
  /**
   * The user's Android Auto split APKs (base plus config splits). AutoMobile never downloads
   * them; they are needed only while the phone still runs the image's stub.
   */
  androidAutoApks: readonly string[];
  /** `desktop-head-unit` binary and head unit config (`.ini`). */
  dhu: { binaryPath: string; configPath: string };
  /**
   * Accept Android Auto's welcome screen (its terms) on the user's behalf. Only set this on
   * the user's explicit instruction; without it a pending welcome screen is reported, not tapped.
   */
  acceptAndroidAutoTerms?: boolean;
  signal?: AbortSignal;
}

export interface AndroidAutoProjectionResult {
  steps: AndroidAutoProvisioningStep[];
  session: DesktopHeadUnitSession;
}

export interface AndroidAutoProjectionProvisionerDeps {
  phone: AndroidAutoPhone;
  ui: AndroidAutoSettingsUi;
  signerCheck: AndroidAutoSignerCheck;
  dhu: DesktopHeadUnitLauncher;
  hostPorts: PortAvailabilityChecker;
  timer: Timer;
  /** Delay before each DHU relaunch after a stall. */
  recoveryBackoff: BackoffPolicy;
  /** Relaunches after the first DHU attempt fails (default 2). */
  maxDhuRecoveries?: number;
}

type Probe = (signal?: AbortSignal) => Promise<boolean>;

/**
 * Prepares a phone emulator for Android Auto projection with no Google account and starts
 * a headless DHU against it. Each step reads its state first and changes nothing when it is
 * already in place, so a rerun on a provisioned phone is a no-op.
 */
export class AndroidAutoProjectionProvisioner {
  private readonly sessions = new Map<string, DesktopHeadUnitSession>();
  /** The device this provisioner redirected host port 5277 to, if any. */
  private redirectOwner: string | null = null;
  /** The provisioning run in progress; the host has one port 5277, so at most one runs. */
  private inFlight: { deviceId: string; run: Promise<AndroidAutoProjectionResult> } | null = null;

  constructor(private readonly deps: AndroidAutoProjectionProvisionerDeps) {}

  /**
   * Provisions `request.deviceId`. A concurrent call for the same device joins the run in
   * progress; one for another device is refused, since both would claim host port 5277.
   */
  provision(request: AndroidAutoProjectionRequest): Promise<AndroidAutoProjectionResult> {
    if (this.inFlight) {
      if (this.inFlight.deviceId === request.deviceId) {
        return this.inFlight.run;
      }
      return Promise.reject(
        new ActionableError(
          `Android Auto provisioning for ${this.inFlight.deviceId} is in progress. The DHU dials host port ${HEAD_UNIT_SERVER_PORT}, so only one emulator per host can project; retry after it finishes.`,
        ),
      );
    }
    try {
      this.assertSingleProjection(request.deviceId);
    } catch (error) {
      return Promise.reject(toActionableError(error, "Android Auto provisioning refused"));
    }
    const run = this.runProvisioning(request).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = { deviceId: request.deviceId, run };
    return run;
  }

  private async runProvisioning(
    request: AndroidAutoProjectionRequest,
  ): Promise<AndroidAutoProjectionResult> {
    const { phone, ui } = this.deps;
    const signal = request.signal;
    const steps: AndroidAutoProvisioningStep[] = [await this.installAndroidAuto(request)];
    steps.push(
      await ensure(
        "keyguard",
        phone.isKeyguardDisabled.bind(phone),
        phone.disableKeyguard.bind(phone),
        signal,
      ),
    );
    steps.push(
      await ensure(
        "stay-awake",
        phone.isStayOnEnabled.bind(phone),
        phone.enableStayOn.bind(phone),
        signal,
      ),
    );
    // Granted before the DHU connects: its preflight poll does not notice a later grant.
    steps.push(
      await ensure(
        "notification-access",
        phone.isNotificationListenerAllowed.bind(phone),
        phone.allowNotificationListener.bind(phone),
        signal,
      ),
    );
    steps.push(
      await ensure(
        "developer-mode",
        ui.isDeveloperModeEnabled.bind(ui),
        ui.enableDeveloperMode.bind(ui),
        signal,
      ),
    );
    steps.push(
      await ensure(
        "unknown-sources",
        ui.isUnknownSourcesEnabled.bind(ui),
        ui.enableUnknownSources.bind(ui),
        signal,
      ),
    );
    steps.push(await this.ensureHeadUnitServer(signal));
    steps.push(await this.ensureTransport(request.deviceId, signal));
    const dhu = await this.ensureDesktopHeadUnit(request);
    steps.push(dhu.step, await this.handleOnboarding(request));
    return { steps, session: dhu.session };
  }

  private assertSingleProjection(deviceId: string): void {
    const other = [...this.sessions].find(
      ([id, session]) => id !== deviceId && session.isRunning(),
    );
    if (other) {
      throw new ActionableError(
        `A Desktop Head Unit is already projecting ${other[0]}. The DHU dials host port ${HEAD_UNIT_SERVER_PORT}, so only one emulator per host can project; stop that session first.`,
      );
    }
  }

  private async installAndroidAuto(
    request: AndroidAutoProjectionRequest,
  ): Promise<AndroidAutoProvisioningStep> {
    const { phone, signerCheck } = this.deps;
    if (await phone.isAndroidAutoSideloaded(request.signal)) {
      return { step: "android-auto-apk", status: "already-done" };
    }
    if (request.androidAutoApks.length === 0) {
      throw new ActionableError(
        "This phone still runs the Android Auto stub, which has no head unit server. Supply the split APKs of an Android Auto release (base plus config splits); AutoMobile never downloads them.",
      );
    }
    try {
      await signerCheck.verify(request.androidAutoApks, request.signal);
    } catch (error) {
      throw toActionableError(error, "Android Auto APK signer check failed");
    }
    await phone.installSplitApks(request.androidAutoApks, request.signal);
    return {
      step: "android-auto-apk",
      status: "applied",
      detail: `installed ${request.androidAutoApks.length} APKs`,
    };
  }

  private async ensureHeadUnitServer(signal?: AbortSignal): Promise<AndroidAutoProvisioningStep> {
    const { phone, ui } = this.deps;
    if (await phone.isHeadUnitServerListening(signal)) {
      return { step: "head-unit-server", status: "already-done" };
    }
    await ui.startHeadUnitServer(signal);
    if (!(await phone.isHeadUnitServerListening(signal))) {
      throw new ActionableError(
        `Android Auto's head unit server is not listening on port ${HEAD_UNIT_SERVER_PORT} after Start head unit server. Check that developer mode is on and start it from Android Auto's overflow menu.`,
      );
    }
    return { step: "head-unit-server", status: "applied" };
  }

  /**
   * A bound host port counts as redirected only when this provisioner redirected it to the
   * same device. Any other holder (another emulator's leftover redirect, an unrelated
   * process) would make the DHU project the wrong phone, so it is refused.
   */
  private async ensureTransport(
    deviceId: string,
    signal?: AbortSignal,
  ): Promise<AndroidAutoProvisioningStep> {
    if (this.deps.hostPorts.isPortAvailable(HEAD_UNIT_SERVER_PORT)) {
      await this.deps.phone.addHeadUnitRedirect(signal);
      this.redirectOwner = deviceId;
      return { step: "transport", status: "applied" };
    }
    if (this.redirectOwner === deviceId) {
      return { step: "transport", status: "already-done" };
    }
    const holder = this.redirectOwner
      ? `${this.redirectOwner}'s redirect`
      : "a redirect or process AutoMobile did not create";
    throw new ActionableError(
      `Host port ${HEAD_UNIT_SERVER_PORT} is held by ${holder}, so the DHU would project that instead of ${deviceId}. Remove it (adb -s <serial> emu redir del tcp:${HEAD_UNIT_SERVER_PORT}) or stop the process holding the port, then retry.`,
    );
  }

  private async ensureDesktopHeadUnit(
    request: AndroidAutoProjectionRequest,
  ): Promise<{ step: AndroidAutoProvisioningStep; session: DesktopHeadUnitSession }> {
    const existing = this.sessions.get(request.deviceId);
    if (existing?.isRunning()) {
      return { step: { step: "desktop-head-unit", status: "already-done" }, session: existing };
    }
    const maxRecoveries = this.deps.maxDhuRecoveries ?? 2;
    const failures: string[] = [];
    for (let attempt = 0; attempt <= maxRecoveries; attempt++) {
      if (attempt > 0) {
        await this.recoverHeadUnitServer(attempt, request.signal);
      }
      const outcome: DhuLaunchOutcome = await this.deps.dhu.launch({
        ...request.dhu,
        signal: request.signal,
      });
      if (outcome.status === "connected") {
        this.sessions.set(request.deviceId, outcome.session);
        const detail = failures.length
          ? `connected after ${failures.length} relaunches`
          : undefined;
        return {
          step: { step: "desktop-head-unit", status: "applied", ...(detail ? { detail } : {}) },
          session: outcome.session,
        };
      }
      failures.push(`${outcome.status}: ${outcome.detail}`);
    }
    throw new ActionableError(
      `The Desktop Head Unit did not hold a connection after ${failures.length} attempts (${failures.join("; ")}). Check the emulator redirect (adb emu redir add tcp:${HEAD_UNIT_SERVER_PORT}:${HEAD_UNIT_SERVER_PORT}) and that Android Auto's head unit server is running.`,
    );
  }

  /** The recovery seen on device: force-stop Android Auto and start its head unit server again. */
  private async recoverHeadUnitServer(attempt: number, signal?: AbortSignal): Promise<void> {
    await this.deps.timer.sleep(this.deps.recoveryBackoff.delayForAttempt(attempt));
    signal?.throwIfAborted();
    await this.deps.phone.forceStopAndroidAuto(signal);
    await this.deps.ui.startHeadUnitServer(signal);
  }

  private async handleOnboarding(
    request: AndroidAutoProjectionRequest,
  ): Promise<AndroidAutoProvisioningStep> {
    const { ui } = this.deps;
    if (!(await ui.isOnboardingPending(request.signal))) {
      return { step: "onboarding", status: "already-done" };
    }
    if (request.acceptAndroidAutoTerms !== true) {
      return {
        step: "onboarding",
        status: "skipped",
        detail:
          "Android Auto shows its welcome screen, which accepts its terms. AutoMobile taps Continue only when asked to accept them (acceptAndroidAutoTerms).",
      };
    }
    await ui.acceptOnboarding(request.signal);
    return { step: "onboarding", status: "applied" };
  }
}

async function ensure(
  step: AndroidAutoProvisioningStepName,
  isDone: Probe,
  apply: (signal?: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
): Promise<AndroidAutoProvisioningStep> {
  signal?.throwIfAborted();
  if (await isDone(signal)) {
    return { step, status: "already-done" };
  }
  await apply(signal);
  return { step, status: "applied" };
}
