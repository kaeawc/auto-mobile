import { ActionableError, toActionableError } from "../../models/ActionableError";
import { exponentialBackoff, type BackoffPolicy } from "../../utils/Backoff";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
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
  /** The config `session`'s DHU was launched with, which a reused DHU keeps. */
  configPath: string;
}

/** The adapters that act on one phone emulator. */
export interface AndroidAutoDeviceAdapters {
  phone: AndroidAutoPhone;
  ui: AndroidAutoSettingsUi;
  signerCheck: AndroidAutoSignerCheck;
}

export interface AndroidAutoProjectionProvisionerDeps {
  /**
   * The adapters for `deviceId`. The provisioner itself is host-wide (one host port 5277), so
   * it resolves its phone-side adapters per request rather than holding one device's.
   */
  forDevice(deviceId: string): AndroidAutoDeviceAdapters;
  dhu: DesktopHeadUnitLauncher;
  hostPorts: PortAvailabilityChecker;
  timer: Timer;
  /** Delay before each DHU relaunch after a stall. */
  recoveryBackoff: BackoffPolicy;
  /** Relaunches after the first DHU attempt fails (default 2). */
  maxDhuRecoveries?: number;
  /** Delay before each re-check that the head unit server is listening after Start head unit server. */
  serverBindBackoff?: BackoffPolicy;
  /** Re-checks after the first one before the head unit server counts as not listening. */
  serverBindAttempts?: number;
}

/** 250, 500, 1000, 2000, 2000 ms: about 5.75 s for the server to bind before the step fails. */
export const DEFAULT_SERVER_BIND_BACKOFF = exponentialBackoff({
  initialDelayMs: 250,
  maxDelayMs: 2_000,
});
export const DEFAULT_SERVER_BIND_ATTEMPTS = 5;

type Probe = (signal?: AbortSignal) => Promise<boolean>;

/**
 * Prepares a phone emulator for Android Auto projection with no Google account and starts
 * a headless DHU against it. Each step reads its state first and changes nothing when it is
 * already in place, so a rerun on a provisioned phone is a no-op.
 */
export class AndroidAutoProjectionProvisioner {
  private readonly sessions = new Map<string, DesktopHeadUnitSession>();
  /**
   * Sessions whose stop failed. They stay tracked (the live DHU still holds host port 5277), but
   * are never reused as `already-done`: the next provision of that serial retries their stop.
   */
  private readonly retired = new WeakSet<DesktopHeadUnitSession>();
  /** The config each tracked DHU was launched with. */
  private readonly launchConfigs = new WeakMap<DesktopHeadUnitSession, string>();
  /** The device this provisioner redirected host port 5277 to, if any. */
  private redirectOwner: string | null = null;
  /** Session-end releases in progress, by device; every provisioning run waits for them. */
  private readonly releasingRedirects = new Map<string, Promise<void>>();
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
        return this.inFlight.run.then(joinedResult);
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
    // A session-end release still removing a redirect must finish first: a run that reused that
    // redirect would have its projection cut when the removal lands (#17901).
    await Promise.all(this.releasingRedirects.values());
    const device = this.deps.forDevice(request.deviceId);
    const { phone, ui } = device;
    const signal = request.signal;
    const steps: AndroidAutoProvisioningStep[] = [await this.installAndroidAuto(device, request)];
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
    steps.push(await this.ensureHeadUnitServer(device, signal));
    steps.push(await this.ensureTransport(phone, request.deviceId, signal));
    const dhu = await this.ensureDesktopHeadUnit(device, request);
    try {
      steps.push(dhu.step, await this.handleOnboarding(ui, request));
    } catch (error) {
      if (dhu.step.status === "applied") {
        await this.stopLaunchedSession(request.deviceId, dhu.session);
      }
      throw error;
    }
    return {
      steps,
      session: dhu.session,
      configPath: this.launchConfigs.get(dhu.session) ?? request.dhu.configPath,
    };
  }

  /**
   * A run that fails after starting its own DHU stops it, so the failure does not leave a live
   * DHU holding host port 5277 for a projection nobody received. A DHU that will not exit stays
   * tracked, so the single-projection check still sees it and the next provision retries.
   */
  private async stopLaunchedSession(
    deviceId: string,
    session: DesktopHeadUnitSession,
  ): Promise<void> {
    await this.stopTrackedSession(deviceId, session, "failed provisioning");
  }

  /**
   * Stops the DHU this provisioner spawned for `deviceId`, through the session's bounded
   * SIGTERM-then-SIGKILL stop, and forgets it so a later emulator that reuses the serial starts
   * its own. Does nothing when this provisioner never spawned one for `deviceId`. Never rejects:
   * a DHU that will not exit stays tracked (it still holds host port 5277) but is never reused.
   * `deviceStopped` also forgets the host port redirect, which ended with that emulator.
   * `releaseRedirect` is for a phone that keeps running after its session ended: once its DHU is
   * gone, the redirect this provisioner added to it is removed, so host port 5277 is free for
   * another phone. A redirect this provisioner did not add is never touched.
   */
  async stopDesktopHeadUnit(
    deviceId: string,
    {
      deviceStopped = false,
      releaseRedirect = false,
    }: { deviceStopped?: boolean; releaseRedirect?: boolean } = {},
  ): Promise<void> {
    if (deviceStopped && this.redirectOwner === deviceId) {
      this.redirectOwner = null;
    }
    if (!releaseRedirect || deviceStopped) {
      await this.stopSession(deviceId, deviceStopped ? "stopped device" : "failed provisioning");
      return;
    }
    // Registered before the first await, so a run that starts during the DHU stop waits too.
    const release = this.stopSession(deviceId, "released session").then(
      async () => await this.removeOwnedRedirect(deviceId),
    );
    this.releasingRedirects.set(deviceId, release);
    try {
      await release;
    } finally {
      if (this.releasingRedirects.get(deviceId) === release) {
        this.releasingRedirects.delete(deviceId);
      }
    }
  }

  private async stopSession(deviceId: string, context: string): Promise<void> {
    const session = this.sessions.get(deviceId);
    if (session) {
      await this.stopTrackedSession(deviceId, session, context);
    }
  }

  /** Whether a DHU this provisioner spawned, or a redirect it added, is on `deviceId`. */
  holdsHostPortFor(deviceId: string): boolean {
    return this.sessions.has(deviceId) || this.redirectOwner === deviceId;
  }

  /** Removes this provisioner's redirect on `deviceId` once no DHU it spawned there is left. */
  private async removeOwnedRedirect(deviceId: string): Promise<void> {
    if (this.redirectOwner !== deviceId || this.sessions.has(deviceId)) {
      // Not ours, or a DHU that would not exit still dials it: the redirect stays.
      return;
    }
    try {
      await this.deps.forDevice(deviceId).phone.removeHeadUnitRedirect();
      if (this.redirectOwner === deviceId) {
        this.redirectOwner = null;
      }
    } catch (error) {
      // Kept as the owner, so the next projection's refusal still names this phone's redirect.
      logger.warn(
        `[AndroidAuto] removing the host port ${HEAD_UNIT_SERVER_PORT} redirect from ${deviceId} failed: ${errorMessage(error)}`,
        error,
      );
    }
  }

  private async stopTrackedSession(
    deviceId: string,
    session: DesktopHeadUnitSession,
    context: string,
  ): Promise<void> {
    try {
      await session.stop();
      if (this.sessions.get(deviceId) === session) {
        this.sessions.delete(deviceId);
      }
    } catch (stopError) {
      this.retired.add(session);
      logger.warn(
        `[AndroidAuto] ${context} ${deviceId} could not stop its Desktop Head Unit; it stays tracked: ${errorMessage(stopError)}`,
        stopError,
      );
    }
  }

  /**
   * Any other device's DHU that has not exited holds host port 5277, healthy or not. It is
   * refused rather than stopped: this call never tears down another device's projection, and
   * that device's redirect would still hold the port. killDevice on that device (which stops its
   * DHU) or re-provisioning it (which restarts an unhealthy DHU) frees it.
   */
  private assertSingleProjection(deviceId: string): void {
    const other = [...this.sessions].find(([id, session]) => id !== deviceId && session.isAlive());
    if (!other) {
      return;
    }
    const [holder, session] = other;
    const state = session.isRunning()
      ? `is already projecting ${holder}`
      : `for ${holder} is unhealthy but still running`;
    throw new ActionableError(
      `A Desktop Head Unit ${state}. The DHU dials host port ${HEAD_UNIT_SERVER_PORT}, so only one emulator per host can project. Call killDevice on ${holder} (which stops its DHU), or re-provision ${holder} to restart an unhealthy DHU, then retry.`,
    );
  }

  private async installAndroidAuto(
    { phone, signerCheck }: AndroidAutoDeviceAdapters,
    request: AndroidAutoProjectionRequest,
  ): Promise<AndroidAutoProvisioningStep> {
    if (await phone.isAndroidAutoSideloaded(request.signal)) {
      return { step: "android-auto-apk", status: "already-done" };
    }
    if (request.androidAutoApks.length === 0) {
      throw new ActionableError(
        "This phone still runs the Android Auto stub, which has no head unit server. Provision it with provisionDevice androidAuto.apkDirectory holding the split APKs of an Android Auto release (base plus config splits); AutoMobile never downloads them.",
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

  private async ensureHeadUnitServer(
    { phone, ui }: AndroidAutoDeviceAdapters,
    signal?: AbortSignal,
  ): Promise<AndroidAutoProvisioningStep> {
    if (await phone.isHeadUnitServerListening(signal)) {
      return { step: "head-unit-server", status: "already-done" };
    }
    await ui.startHeadUnitServer(signal);
    if (!(await this.waitForHeadUnitServer(phone, signal))) {
      throw new ActionableError(
        `Android Auto's head unit server is not listening on port ${HEAD_UNIT_SERVER_PORT} after Start head unit server. Check that developer mode is on and start it from Android Auto's overflow menu.`,
      );
    }
    return { step: "head-unit-server", status: "applied" };
  }

  /** The server binds tcp:5277 some time after the menu tap, so poll on a bounded backoff. */
  private async waitForHeadUnitServer(
    phone: AndroidAutoPhone,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const { timer } = this.deps;
    const backoff = this.deps.serverBindBackoff ?? DEFAULT_SERVER_BIND_BACKOFF;
    const attempts = this.deps.serverBindAttempts ?? DEFAULT_SERVER_BIND_ATTEMPTS;
    for (let attempt = 0; attempt <= attempts; attempt++) {
      if (attempt > 0) {
        await timer.sleep(backoff.delayForAttempt(attempt));
        signal?.throwIfAborted();
      }
      if (await phone.isHeadUnitServerListening(signal)) {
        return true;
      }
    }
    return false;
  }

  /**
   * A bound host port counts as redirected only when this provisioner redirected it to the
   * same device. Any other holder (another emulator's leftover redirect, an unrelated
   * process) would make the DHU project the wrong phone, so it is refused.
   */
  private async ensureTransport(
    phone: AndroidAutoPhone,
    deviceId: string,
    signal?: AbortSignal,
  ): Promise<AndroidAutoProvisioningStep> {
    if (this.deps.hostPorts.isPortAvailable(HEAD_UNIT_SERVER_PORT)) {
      await phone.addHeadUnitRedirect(signal);
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

  /** A tracked, healthy DHU whose stop never failed; a retired one is stopped, not reused. */
  private reusableSession(deviceId: string): DesktopHeadUnitSession | undefined {
    const existing = this.sessions.get(deviceId);
    return existing?.isRunning() && !this.retired.has(existing) ? existing : undefined;
  }

  /** A reused DHU keeps its launch config; a request for another config is told how to get it. */
  private reusedStep(
    session: DesktopHeadUnitSession,
    requestedConfig: string,
  ): AndroidAutoProvisioningStep {
    const running = this.launchConfigs.get(session);
    if (!running || running === requestedConfig) {
      return { step: "desktop-head-unit", status: "already-done" };
    }
    return {
      step: "desktop-head-unit",
      status: "already-done",
      detail: `reused the running DHU, started with ${running}; killDevice stops it so one can start with ${requestedConfig}`,
    };
  }

  private async ensureDesktopHeadUnit(
    device: AndroidAutoDeviceAdapters,
    request: AndroidAutoProjectionRequest,
  ): Promise<{ step: AndroidAutoProvisioningStep; session: DesktopHeadUnitSession }> {
    const reusable = this.reusableSession(request.deviceId);
    if (reusable) {
      return { step: this.reusedStep(reusable, request.dhu.configPath), session: reusable };
    }
    const existing = this.sessions.get(request.deviceId);
    // An unhealthy session can still own a live DHU; wait for it to exit (stop() rejects if it
    // never does) so a relaunch cannot compete with it for the head unit connection.
    await existing?.stop();
    this.sessions.delete(request.deviceId);
    const maxRecoveries = this.deps.maxDhuRecoveries ?? 2;
    const failures: string[] = [];
    for (let attempt = 0; attempt <= maxRecoveries; attempt++) {
      if (attempt > 0 && !(await this.recoverHeadUnitServer(device, attempt, request.signal))) {
        failures.push(
          `head-unit-server: not listening on port ${HEAD_UNIT_SERVER_PORT} after the restart`,
        );
        continue;
      }
      const outcome: DhuLaunchOutcome = await this.deps.dhu.launch({
        ...request.dhu,
        signal: request.signal,
      });
      if (outcome.status === "connected") {
        this.sessions.set(request.deviceId, outcome.session);
        this.launchConfigs.set(outcome.session, request.dhu.configPath);
        const detail = failures.length
          ? `connected after ${failures.length} relaunches`
          : undefined;
        return {
          step: { step: "desktop-head-unit", status: "applied", ...(detail ? { detail } : {}) },
          session: outcome.session,
        };
      }
      if (outcome.status === "unkillable") {
        // Tracked, not dropped: the live DHU still dials host port 5277, so the single
        // projection check must see it, and the next provision of this device retries its stop.
        this.sessions.set(request.deviceId, outcome.session);
        throw new ActionableError(
          `The Desktop Head Unit for ${request.deviceId} failed and did not exit after SIGTERM and SIGKILL (${outcome.detail}). It still holds host port ${HEAD_UNIT_SERVER_PORT}; end the desktop-head-unit process, then provision ${request.deviceId} again.`,
        );
      }
      failures.push(`${outcome.status}: ${outcome.detail}`);
    }
    throw new ActionableError(
      `The Desktop Head Unit did not hold a connection after ${failures.length} attempts (${failures.join("; ")}). Check the emulator redirect (adb emu redir add tcp:${HEAD_UNIT_SERVER_PORT}:${HEAD_UNIT_SERVER_PORT}) and that Android Auto's head unit server is running.`,
    );
  }

  /**
   * The recovery seen on device: force-stop Android Auto and start its head unit server again.
   * Resolves false when the restarted server does not bind tcp:5277 within the bounded wait,
   * so the caller skips a relaunch that could only dial an unbound port.
   */
  private async recoverHeadUnitServer(
    { phone, ui }: AndroidAutoDeviceAdapters,
    attempt: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    await this.deps.timer.sleep(this.deps.recoveryBackoff.delayForAttempt(attempt));
    signal?.throwIfAborted();
    await phone.forceStopAndroidAuto(signal);
    await ui.startHeadUnitServer(signal);
    return this.waitForHeadUnitServer(phone, signal);
  }

  private async handleOnboarding(
    ui: AndroidAutoSettingsUi,
    request: AndroidAutoProjectionRequest,
  ): Promise<AndroidAutoProvisioningStep> {
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

/**
 * A call that joined another call's run did not start that run's DHU: report it as already done,
 * so the joiner never counts itself the DHU's owner (and a timed-out joiner never stops it).
 */
function joinedResult(result: AndroidAutoProjectionResult): AndroidAutoProjectionResult {
  return {
    ...result,
    steps: result.steps.map((step) =>
      step.step === "desktop-head-unit" && step.status === "applied"
        ? { step: step.step, status: "already-done", detail: "joined the run in progress" }
        : step,
    ),
  };
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
