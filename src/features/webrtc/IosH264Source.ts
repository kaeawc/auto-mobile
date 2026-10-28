import { wireHelperDiagnostics } from "./IosCaptureDiagnostics";
import { ActionableError, toActionableError } from "../../models";
import type { BackoffPolicy } from "../../utils/Backoff";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type {
  CaptureTarget,
  DecodedEncodedVideo,
  IosScreenCaptureHelperOptions,
  IosScreenCaptureReadinessPhase,
} from "../screen-stream";
import {
  ENCODED_VIDEO_CAPABILITY,
  IosScreenCaptureHelper,
  type CapturePermission,
} from "../screen-stream/IosScreenCaptureHelper";
import {
  iosSimulatorCaptureHelperPool,
  type IosSimulatorCaptureHelperPool,
} from "../screen-stream/IosSimulatorCaptureHelperPool";
import { ScreenCaptureHelperProvider } from "../screen-stream/ScreenCaptureHelperProvider";
import { EncodedUnsupportedError } from "./EncodedUnsupportedError";
import type { H264CaptureSource } from "./H264CaptureSource";
import { IosCaptureStartup } from "./IosCaptureStartup";
import { NoFirstFrameError } from "./NoFirstFrameError";
import { ScreenRecordingPermissionError } from "./ScreenRecordingPermissionError";
import {
  IosCaptureResolver,
  resolveEncodeSettings,
  defaultCommandRunner,
  defaultResolveSimulatorWindowId,
  describeCaptureTarget,
  hasScreenRecordingPermissionDenial,
  defaultScreenRecordingApprovalTarget,
} from "./IosCaptureResolver";
import {
  DEFAULT_IOS_WEBRTC_FPS,
  IOS_FIRST_FRAME_TIMEOUT_MS,
  IOS_SIMULATOR_TARGET_RESOLUTION_TIMEOUT_MS,
  IOS_ENCODED_FORCED_KEYFRAME_MIN_INTERVAL_MS,
  IOS_HELPER_STOP_TIMEOUT_MS,
  resolveRunningReconnect,
  type CommandRunner,
  type IosH264SourceOptions,
  type IosH264FrameMetrics,
  type IosH264SourcePhase,
  type IosFrameCaptureHelper,
  type IosFrameCaptureHelperFactory,
  type IosSimulatorWindowResolver,
  type ScreenCaptureHelperEnsurer,
} from "./IosH264SourceConfig";
export { ScreenRecordingPermissionError } from "./ScreenRecordingPermissionError";

export {
  IOS_SCREEN_CAPTURE_HELPER_ENV,
  IOS_SCREEN_CAPTURE_HELPER_ENV_ALIAS,
  resolveIosScreenCaptureHelperPath,
} from "../screen-stream/screenCaptureHelperPath";

export * from "./IosH264SourceConfig";
export * from "./IosCaptureResolver";

export class IosH264Source implements H264CaptureSource {
  private readonly resolver: IosCaptureResolver;
  private nativeFrameMetrics: IosH264FrameMetrics["native"] = null;
  private captureKind: CaptureTarget["kind"] | null = null;
  private lastForcedKeyFrameMs = Number.NEGATIVE_INFINITY;
  private readonly startup: IosCaptureStartup;
  getFrameMetrics(): IosH264FrameMetrics {
    return { native: this.nativeFrameMetrics };
  }

  private readonly helperPath?: string;
  private readonly fps: number;
  private readonly createHelper: IosFrameCaptureHelperFactory;
  private readonly simulatorWindowResolver: IosSimulatorWindowResolver;
  private readonly commandRunner: CommandRunner;
  private readonly helperPathExists?: (candidate: string) => boolean;
  private readonly screenCaptureHelperProvider: ScreenCaptureHelperEnsurer;
  private readonly timer: Timer;
  private readonly firstFrameTimeoutMs: number;
  private readonly simulatorHelperPool: IosSimulatorCaptureHelperPool;
  private readonly runningReconnectMaxAttempts: number;
  private readonly runningReconnectBackoff: BackoffPolicy;

  private helper: IosFrameCaptureHelper | null = null;
  /** Invalidates async work and helper callbacks from a stopped capture lifecycle. */
  private helperGeneration = 0;
  private cancelPreCaptureDeadline: (() => void) | null = null;
  /** Set once the helper advertises the encoded-video capability this attempt. */
  private encodedCapabilityConfirmed = false;
  private nativeIdleCapabilityConfirmed = false;
  private idleSupportReported = false;
  private teardownPromise: Promise<void> | null = null;
  /** Bounded tail of the helper's non-metrics stderr lines, newest last. */
  private helperStderrTail: string[] = [];
  private lastReadinessPhase: IosScreenCaptureReadinessPhase | null = null;
  private phase: IosH264SourcePhase = "idle";
  private requiredPermission: CapturePermission | null = null;
  private requiredPermissionTarget: string | null = null;
  /**
   * True once `start()` has fully resolved (first frame — and, when enabled,
   * first audio — delivered). Running-phase reconnect only covers steady-state
   * failures after this point; a failure during the initial handshake surfaces
   * so a genuine misconfiguration is not hidden behind a retry loop.
   */
  private startupComplete = false;
  /** The relay can keep a source warm briefly after its last viewer leaves. */
  private hasConsumers = true;
  private deferredHelperFailure: Error | null = null;
  private invalidateHelperOnStop = false;
  private reconnectPromise: Promise<void> | null = null;
  /** Cancels an in-flight reconnect backoff wait; resolves it as "cancelled". */
  private cancelReconnectDelay: (() => void) | null = null;

  constructor(private readonly options: IosH264SourceOptions) {
    this.helperPath = options.helperPath;
    this.fps = options.fps ?? DEFAULT_IOS_WEBRTC_FPS;
    this.createHelper =
      options.createHelper ?? ((helperOptions) => new IosScreenCaptureHelper(helperOptions));
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
    this.helperPathExists = options.helperPathExists;
    this.screenCaptureHelperProvider =
      options.screenCaptureHelperProvider ?? ScreenCaptureHelperProvider.getInstance();
    this.timer = options.timer ?? defaultTimer;
    this.firstFrameTimeoutMs = options.firstFrameTimeoutMs ?? IOS_FIRST_FRAME_TIMEOUT_MS;
    this.simulatorHelperPool = options.simulatorHelperPool ?? iosSimulatorCaptureHelperPool;
    const reconnect = resolveRunningReconnect(options);
    this.runningReconnectMaxAttempts = reconnect.maxAttempts;
    this.runningReconnectBackoff = reconnect.backoff;
    this.simulatorWindowResolver =
      options.simulatorWindowResolver ??
      ((helperPath, device, audioEnabled, signal) =>
        defaultResolveSimulatorWindowId(
          helperPath,
          device,
          this.commandRunner,
          audioEnabled,
          signal,
          {
            timer: this.timer,
            // The loop reserves one interval before each sleep, so the budget is the whole
            // timeout; subtracting an interval here too wasted one (#13066).
            pollBudgetMs: Math.max(0, IOS_SIMULATOR_TARGET_RESOLUTION_TIMEOUT_MS),
          },
        ));
    this.startup = new IosCaptureStartup(this.timer, this.firstFrameTimeoutMs, {
      generation: () => this.helperGeneration,
      lastReadinessPhase: () => this.lastReadinessPhase,
      markRunning: () => {
        this.phase = "running";
      },
      isCurrentHelper: (helper, generation) => this.isCurrentHelper(helper, generation),
      isActive: () => this.isActive(),
      helperFailureFor: (line) => this.helperFailureFor(line),
      failIfCurrentHelper: (helper, generation, error) =>
        this.failIfCurrentHelper(helper, generation, error),
      describeHelperExit: (info, what) => this.describeHelperExit(info, what),
      encodedStartupError: (error) => this.encodedStartupError(error),
      encodedCapabilityConfirmed: () => this.encodedCapabilityConfirmed,
    });
    this.resolver = new IosCaptureResolver({
      options: this.options,
      helperPath: this.helperPath,
      helperPathExists: this.helperPathExists,
      screenCaptureHelperProvider: this.screenCaptureHelperProvider,
      fps: this.fps,
      timer: this.timer,
      simulatorWindowResolver: this.simulatorWindowResolver,
      withPreCaptureDeadline: (operation, timeoutMs, context) =>
        this.withPreCaptureDeadline(operation, timeoutMs, context),
    });
  }

  async start(): Promise<void> {
    if (this.isActive()) {
      throw new ActionableError("iOS H.264 source already started.");
    }
    await this.teardownPromise;
    const generation = ++this.helperGeneration;
    this.phase = "starting";
    this.startupComplete = false;
    this.deferredHelperFailure = null;
    this.helperStderrTail = [];
    this.lastReadinessPhase = null;
    this.nativeFrameMetrics = null;
    this.lastForcedKeyFrameMs = Number.NEGATIVE_INFINITY;
    this.encodedCapabilityConfirmed = false;
    if (this.options.size !== undefined) {
      logger.warn(
        "[IosH264Source] iOS ignores explicit encoder size; capture encodes at native size capped by the quality preset.",
      );
    }

    try {
      await this.establishCapture(generation);
      if (generation === this.helperGeneration) {
        this.startupComplete = this.phaseNow() === "running";
      }
    } catch (error) {
      if (generation !== this.helperGeneration) {
        return; // stop() owns teardown of this superseded startup.
      }
      this.phase = "stopping";
      await this.beginTeardown();
      throw error;
    }
  }

  /**
   * Resolve the helper + capture target and bring capture up to the first
   * frame. Shared by the initial {@link start} and the running-phase reconnect
   * loop so both establish capture through exactly the same path. On success the
   * phase is `"running"` (set by the first-frame handler); a `stop()` that races
   * the handshake leaves it non-`"running"`, which callers treat as "not up".
   */
  private async establishCapture(generation: number): Promise<void> {
    const helperPath = await this.resolver.resolveHelperPath();
    if (generation !== this.helperGeneration) {
      return;
    }
    const target = await this.resolver.resolveCaptureTarget(helperPath);
    this.captureKind = target.kind;
    if (!this.isActive() || generation !== this.helperGeneration) {
      return;
    }
    await this.startCaptureWithSimulatorRetry(helperPath, {
      ...target,
      encode: resolveEncodeSettings(this.options, target.kind),
    });
  }

  async stop(): Promise<void> {
    this.deferredHelperFailure = null;
    if (!this.isActive()) {
      await this.teardownPromise;
      return;
    }
    this.phase = "stopping";
    this.helperGeneration++;
    this.startupComplete = false;
    this.cancelPreCaptureDeadline?.();
    this.cancelReconnectDelay?.();
    this.startup.cancelFirstFrameWait?.();
    this.startup.cancelFirstAudioWait?.();
    await this.beginTeardown();
  }

  async stopStale(producerStale: boolean = true): Promise<void> {
    this.invalidateHelperOnStop = producerStale;
    await this.stop();
  }

  /** Called by the local relay when its first viewer arrives or last viewer leaves. */
  setHasConsumers(hasConsumers: boolean): void {
    this.hasConsumers = hasConsumers;
    if (hasConsumers) {
      if (this.deferredHelperFailure) {
        this.queueReconnect(this.deferredHelperFailure);
      }
    } else {
      this.cancelReconnectDelay?.();
    }
  }

  /**
   * Encoded-path keyframe request (issue #4789): write `{"cmd":"forceKeyFrame"}`
   * on the helper's STDIN control channel so the running VTCompressionSession
   * forces an IDR on its next frame — no encoder restart. The PLI throttle is kept
   * in TS for parity with Android's throttle placement, at the much shorter
   * {@link IOS_ENCODED_FORCED_KEYFRAME_MIN_INTERVAL_MS} the cheap in-helper force
   * allows. The throttle clock only advances on a successful signal, so a helper
   * that momentarily has no control channel is retried on the next request.
   */
  requestKeyFrame(): boolean {
    if (this.phase !== "running" || !this.helper) {
      return false;
    }
    const now = this.timer.now();
    if (now - this.lastForcedKeyFrameMs < IOS_ENCODED_FORCED_KEYFRAME_MIN_INTERVAL_MS) {
      return false;
    }
    const sent = this.helper.requestKeyFrame?.() ?? false;
    if (sent) {
      this.lastForcedKeyFrameMs = now;
      logger.debug("[IosH264Source] forced keyframe requested on helper control channel");
    }
    return sent;
  }

  private async withPreCaptureDeadline<T>(
    operation: Promise<T>,
    timeoutMs: number,
    context: string,
  ): Promise<T> {
    const deadline = new AbortController();
    const cancel = (): void => deadline.abort(new ActionableError(`${context} cancelled by stop.`));
    this.cancelPreCaptureDeadline = cancel;
    const timeout = this.timer.setTimeout(
      () => deadline.abort(new ActionableError(`${context} timed out after ${timeoutMs}ms.`)),
      timeoutMs,
    );
    try {
      return await raceWithDeadline(operation, {
        timer: this.timer,
        signal: deadline.signal,
        label: context,
      });
    } finally {
      if (this.cancelPreCaptureDeadline === cancel) {
        this.cancelPreCaptureDeadline = null;
      }
      if (timeout) {
        this.timer.clearTimeout(timeout);
      }
    }
  }

  private createCaptureHelper(options: IosScreenCaptureHelperOptions): IosFrameCaptureHelper {
    if (options.target.kind === "simulator" && !this.options.createHelper) {
      return this.simulatorHelperPool.acquire(options);
    }
    return this.createHelper(options);
  }

  private async startCaptureWithSimulatorRetry(
    helperPath: string,
    target: CaptureTarget,
  ): Promise<void> {
    const shouldRetryNoFirstFrame = target.kind === "simulator" && !this.options.createHelper;
    let currentTarget = target;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.startCaptureAttempt(helperPath, currentTarget);
        return;
      } catch (error) {
        // Preserve the actionable version-skew failure without retrying an old binary.
        if (error instanceof EncodedUnsupportedError) {
          throw error;
        }
        if (!shouldRetryNoFirstFrame || !(error instanceof NoFirstFrameError)) {
          throw toActionableError(error, "Failed to start iOS screen capture");
        }
        try {
          await this.helper?.invalidate?.();
        } catch (error) {
          throw toActionableError(error, "Failed to invalidate silent iOS Simulator capture");
        }
        await this.stopCurrentHelper();
        if (!this.isActive()) {
          return;
        }
        if (attempt !== 0) {
          throw error.finalStartupError(this.requiredPermissionTarget);
        }
        // The failed lease is invalidated above, so one new ScreenCaptureKit session
        // can recover a transient no-frame startup without surfacing a warning.
        logger.debug(
          `[IosH264Source] no first frame from pooled Simulator helper for ${describeCaptureTarget(currentTarget)}; retrying once`,
        );
        // A Simulator relaunch/reboot/window-recreation between attempts changes the
        // CGWindowID, so reusing the stale windowID would deterministically retry
        // against a dead window. Re-resolve it under the same 2s deadline
        // (IOS_SIMULATOR_TARGET_RESOLUTION_TIMEOUT_MS) so the retry targets the live
        // window without consuming the whole startup budget.
        currentTarget = await this.reresolveSimulatorTarget(helperPath, currentTarget);
      }
    }
  }

  private reresolveSimulatorTarget(
    helperPath: string,
    target: CaptureTarget,
  ): Promise<CaptureTarget> {
    return this.resolver.reresolveSimulatorTarget(helperPath, target);
  }

  private async startCaptureAttempt(helperPath: string, target: CaptureTarget): Promise<void> {
    logger.info(
      `[IosH264Source] starting screen-capture-helper for ${describeCaptureTarget(target)}`,
    );
    this.lastReadinessPhase = null;
    this.requiredPermission = null;
    this.requiredPermissionTarget = defaultScreenRecordingApprovalTarget(helperPath);
    this.nativeIdleCapabilityConfirmed = false;
    this.idleSupportReported = false;
    const helper = this.createCaptureHelper({ binaryPath: helperPath, target });
    this.helper = helper;
    this.encodedCapabilityConfirmed = false;
    this.wireEncodedHelper(helper);
    const firstAudio = this.options.audioEnabled ? this.startup.waitForFirstAudio(helper) : null;
    const firstRecord = this.startup.waitForFirstEncodedRecord(helper, target);
    try {
      await Promise.all([firstRecord, firstAudio, Promise.resolve().then(() => helper.start())]);
    } catch (error) {
      throw this.encodedStartupError(
        error instanceof Error ? error : new Error(errorMessage(error)),
      );
    }
  }

  /**
   * Classify an encoded-startup failure. A helper that exited/errored WITHOUT ever
   * advertising the encoded-video capability predates `--encode h264` (an old
   * binary rejects the flag and exits), so return {@link EncodedUnsupportedError}
   * with upgrade guidance. A capable helper's failure is returned as-is.
   */
  private encodedStartupError(error: Error): Error {
    if (
      this.encodedCapabilityConfirmed ||
      error instanceof ScreenRecordingPermissionError ||
      error instanceof EncodedUnsupportedError
    ) {
      return error;
    }
    return new EncodedUnsupportedError(
      `The screen-capture-helper did not advertise the '${ENCODED_VIDEO_CAPABILITY}' capability ` +
        `before failing to start encoded capture (${error.message}). Update to the screen-capture-helper from the matching AutoMobile release, or rebuild the local helper and update AUTOMOBILE_IOS_SCREEN_CAPTURE_HELPER.`,
    );
  }

  /**
   * Wire the encoded-path helper (issue #4789): Annex-B records go straight to
   * `onData`, the capability handshake is tracked so a startup failure can be
   * classified as a version skew, and a decoder resync requests a keyframe —
   * discarded bytes may have included reference frames, so recovery needs an IDR.
   */
  private wireEncodedHelper(helper: IosFrameCaptureHelper): void {
    const generation = this.helperGeneration;
    helper.on("encodedVideo", (video) => {
      if (this.isCurrentHelper(helper, generation)) {
        this.handleEncodedVideo(video);
      }
    });
    helper.on("capability", (token) => {
      if (this.isCurrentHelper(helper, generation) && token === ENCODED_VIDEO_CAPABILITY) {
        this.encodedCapabilityConfirmed = true;
      }
    });
    helper.on("malformed", (error) => {
      if (!this.isCurrentHelper(helper, generation)) {
        return;
      }
      logger.warn(
        `[IosH264Source] malformed encoded record from helper: ${error.reason}; requesting keyframe to recover`,
      );
      this.requestKeyFrame();
    });
    this.wireHelperDiagnostics(helper);
  }

  private wireHelperDiagnostics(helper: IosFrameCaptureHelper): void {
    const generation = this.helperGeneration;
    wireHelperDiagnostics(helper, {
      isCurrentHelper: () => this.isCurrentHelper(helper, generation),
      isActive: () => this.isActive(),
      confirmIdleSupport: () => {
        this.nativeIdleCapabilityConfirmed = true;
        this.idleSupportReported = true;
      },
      nativeIdleCapabilityConfirmed: () => this.nativeIdleCapabilityConfirmed,
      setRequiredPermission: (permission) => {
        this.requiredPermission = permission;
      },
      setRequiredPermissionTarget: (target) => {
        this.requiredPermissionTarget = target;
      },
      setLastReadinessPhase: (phase) => {
        this.lastReadinessPhase = phase;
      },
      helperStderrTail: () => this.helperStderrTail,
      failForHelperLine: (line) =>
        this.failIfCurrentHelper(helper, generation, this.helperFailureFor(line)),
      setNativeFrameMetrics: (metrics) => {
        this.nativeFrameMetrics = metrics;
        this.options.onFrameMetrics?.(this.getFrameMetrics());
      },
      options: this.options,
    });
  }

  private helperFailureFor(line: string): Error {
    return this.requiredPermission === "screen-recording" ||
      hasScreenRecordingPermissionDenial(line)
      ? new ScreenRecordingPermissionError(this.requiredPermissionTarget ?? "AutoMobile")
      : new Error(`screen-capture-helper reported an error: ${line}`);
  }

  /**
   * Forward one in-helper-encoded Annex-B access unit downstream (issue #4789).
   * The helper already produced a self-contained H.264 record (SPS/PPS prepended
   * on keyframes), so there is no ffmpeg encoder in this path — the record is the
   * output. The PTS-carrying header is consumed by the wire timing upstream; this
   * source only relays the elementary-stream bytes.
   */
  private handleEncodedVideo(video: DecodedEncodedVideo): void {
    if (!this.isActive() || !this.encodedCapabilityConfirmed) {
      return;
    }
    this.reportLegacyIdleSupport();
    this.options.onSourceFrame?.();
    this.options.onData(video.payload);
    this.options.onEncodedAccessUnit?.();
  }

  private reportLegacyIdleSupport(): void {
    if (this.captureKind === "simulator" && !this.idleSupportReported) {
      this.idleSupportReported = true;
      this.options.onIdleAttestationSupport?.(false);
    }
  }

  private failIfRunning(error: Error): void {
    if (this.phase !== "running") {
      return;
    }
    // Initial handshakes and fail-fast streams must surface their real failure.
    if (!this.startupComplete || this.runningReconnectMaxAttempts <= 0) {
      this.failNow(error);
      return;
    }
    if (!this.hasConsumers) {
      // Keep the relay's idle grace, but do not launch another helper for an
      // empty stream. A new viewer resumes the same bounded recovery path.
      this.phase = "reconnecting";
      this.startupComplete = false;
      void this.beginTeardown();
      this.queueReconnect(error);
      return;
    }
    this.phase = "reconnecting";
    this.startupComplete = false;
    this.queueReconnect(error);
  }

  /** Terminal failure: tear the source down and surface `onError`. */
  private failNow(error: Error): void {
    this.startup.rejectFirstAudioWait?.(error);
    this.phase = "stopping";
    this.startupComplete = false;
    void this.beginTeardown();
    this.options.onError?.(error);
  }

  /**
   * Bounded running-phase reconnect. Tears down the failed helper/encoder, then
   * re-establishes capture up to {@link runningReconnectMaxAttempts} times with
   * {@link runningReconnectBackoff} between attempts. On success the source
   * resumes running with no `onError`; on exhaustion the original failure is
   * surfaced. A `stop()` at any point cancels the cycle. This keeps a long-lived
   * automation stream alive across a transient blip, mirroring how
   * {@link AndroidH264Source} re-establishes its persistent session (PR #4413).
   */
  private async runReconnect(initialError: Error): Promise<void> {
    logger.warn(
      `[IosH264Source] running-phase capture failure; attempting bounded reconnect ` +
        `(up to ${this.runningReconnectMaxAttempts}): ${initialError.message}`,
    );
    await this.beginTeardown();

    if (!this.hasConsumers) {
      this.deferredHelperFailure = initialError;
      return;
    }

    for (
      let attempt = 1;
      this.phase === "reconnecting" && attempt <= this.runningReconnectMaxAttempts;
      attempt++
    ) {
      const delayMs = this.runningReconnectBackoff.delayForAttempt(attempt);
      if (!(await this.waitForActiveReconnect(delayMs, initialError))) {
        return;
      }
      this.phase = "starting";
      const generation = ++this.helperGeneration;
      try {
        await this.establishCapture(generation);
        if (generation !== this.helperGeneration) {
          return;
        }
        if (this.phaseNow() === "running") {
          this.startupComplete = true;
          logger.info(`[IosH264Source] running-phase reconnect succeeded on attempt ${attempt}`);
          return;
        }
        // A stop() raced the handshake; teardown is owned by stop().
        return;
      } catch (error) {
        if (generation !== this.helperGeneration) {
          return; // stop() owns teardown of this superseded attempt.
        }
        logger.warn(
          `[IosH264Source] reconnect attempt ${attempt}/${this.runningReconnectMaxAttempts} failed: ` +
            `${errorMessage(error)}`,
        );
        await this.beginTeardown();
        const phase = this.phaseNow();
        if (phase === "stopping" || phase === "idle") {
          return; // stop() won during the attempt.
        }
        if (error instanceof EncodedUnsupportedError) {
          this.failNow(error);
          return;
        }
        this.phase = "reconnecting";
      }
    }

    this.finishReconnectExhausted(initialError);
  }

  private finishReconnectExhausted(initialError: Error): void {
    if (this.phase !== "reconnecting") {
      return;
    }
    if (!this.hasConsumers) {
      this.deferredHelperFailure = initialError;
      return;
    }
    this.failNow(initialError);
  }

  private async waitForActiveReconnect(delayMs: number, error: Error): Promise<boolean> {
    const cancelled = await this.waitReconnectBackoff(delayMs);
    if (this.phase === "reconnecting" && (!this.hasConsumers || cancelled)) {
      // A viewer may have returned before a cancelled wait resumed.
      this.deferredHelperFailure = error;
    }
    return !cancelled && this.hasConsumers && this.phase === "reconnecting";
  }

  private queueReconnect(error: Error): void {
    this.deferredHelperFailure = error;
    if (!this.hasConsumers || this.phase !== "reconnecting" || this.reconnectPromise) {
      return;
    }
    this.deferredHelperFailure = null;
    this.reconnectPromise = this.runReconnect(error).finally(() => {
      this.reconnectPromise = null;
      if (this.deferredHelperFailure && this.hasConsumers) {
        this.queueReconnect(this.deferredHelperFailure);
      }
    });
  }

  /**
   * Resolve after `delayMs`, or immediately with `true` if {@link cancelReconnectDelay}
   * fires first (a `stop()` during the backoff). Uses the injected {@link Timer}
   * so reconnect timing is deterministic under a FakeTimer.
   */
  private waitReconnectBackoff(delayMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const handle = this.timer.setTimeout(() => {
        this.cancelReconnectDelay = null;
        resolve(false);
      }, delayMs);
      this.cancelReconnectDelay = (): void => {
        this.timer.clearTimeout(handle);
        this.cancelReconnectDelay = null;
        resolve(true);
      };
    });
  }

  /** Exit code/signal plus the helper's last stderr lines, for the stream failure. */
  private describeHelperExit(
    info: { code: number | null; signal: NodeJS.Signals | null },
    what: string,
  ): string {
    const tail =
      this.helperStderrTail.length === 0
        ? ""
        : `; last stderr: ${this.helperStderrTail.join(" | ")}`;
    return `screen-capture-helper ${what} (code=${info.code}, signal=${info.signal})${tail}`;
  }

  private failIfCurrentHelper(
    helper: IosFrameCaptureHelper,
    generation: number,
    error: Error,
  ): void {
    if (!this.isCurrentHelper(helper, generation)) {
      return;
    }
    this.failIfRunning(error);
  }

  private isCurrentHelper(helper: IosFrameCaptureHelper, generation: number): boolean {
    return this.helper === helper && this.helperGeneration === generation;
  }

  private isActive(): boolean {
    return this.phase === "starting" || this.phase === "running" || this.phase === "reconnecting";
  }

  /**
   * Read the current phase through a method boundary so a comparison after an
   * `await` is not defeated by TypeScript's flow narrowing: an async callback
   * (a frame handler flipping the phase to `"running"`, a `stop()`) can mutate
   * `this.phase` while an `await` is suspended, which control-flow analysis
   * cannot see.
   */
  private phaseNow(): IosH264SourcePhase {
    return this.phase;
  }

  private beginTeardown(): Promise<void> {
    this.teardownPromise ??= this.teardown().finally(() => {
      this.teardownPromise = null;
      if (this.phase === "stopping") {
        this.phase = "idle";
      }
    });
    return this.teardownPromise;
  }

  private async teardown(): Promise<void> {
    await this.stopCurrentHelper();
  }

  private async stopCurrentHelper(): Promise<void> {
    this.startup.cancelFirstFrameWait?.();
    this.startup.cancelFirstFrameWait = null;
    this.startup.cancelFirstAudioWait?.();
    this.startup.cancelFirstAudioWait = null;
    this.startup.rejectFirstAudioWait = null;
    const helper = this.helper;
    this.helper = null;
    if (!helper) {
      return;
    }
    const stopped = (
      this.invalidateHelperOnStop && helper.invalidate ? helper.invalidate() : helper.stop()
    ).then(
      () => true,
      (error: unknown) => {
        logger.debug(`[IosH264Source] helper stop failed: ${error}`);
        return true;
      },
    );
    const timedOut = Symbol("helper stop timeout");
    try {
      await raceWithDeadline(stopped, {
        timer: this.timer,
        timeoutMs: IOS_HELPER_STOP_TIMEOUT_MS,
        label: "iOS capture helper stop",
        timeoutError: () => timedOut,
      });
    } catch (error) {
      if (error !== timedOut) {
        throw error;
      }
      logger.warn(
        `[IosH264Source] helper stop exceeded ${IOS_HELPER_STOP_TIMEOUT_MS}ms; continuing teardown`,
      );
    }
  }
}
