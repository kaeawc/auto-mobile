import type { AndroidFoldPostureRestore } from "./androidFoldPostureRestore";
import { mutationIncarnation } from "./mutations/incarnation";
import {
  ctrlProxyDeadlineMs,
  isTransientAdbTimeout,
  pollUntilWithinBudget,
  retryAdbWithinBudget,
} from "./androidResetBudget";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { BootedDevice, DeviceInfo } from "../../models/DeviceInfo";
import type { AdbCommandRunner } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { parseAndroidSystemImageRuntime } from "../../utils/android-cmdline-tools/AndroidSystemImageRuntime";
import { outputLooksLikeShellFailure } from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import { isUnknownEmulatorName } from "../../utils/android-cmdline-tools/emulatorReadinessEvaluation";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { getAbortSignal } from "../../utils/AbortContext";
import { logger } from "../../utils/logger";
import type { BrokerNativeProfile } from "./profile";
import type { ExecutionTracker } from "../executionTracker";
import type { ResetOutcome } from "./devicePort";
import { ResetFailureError } from "./ResetFailureError";
import type { DeviceMutationResetContext } from "./mutations/reset";

export const DEFAULT_ANDROID_RESET_TIMEOUT_MS = 600_000;
const ANDROID_BASELINE_STEP_ATTEMPTS = 3;
// User snapshot capture writes emulator state outside the guest that a broker snapshot load keeps.
// Host-side state (AVD config, mock-network rules) survives snapshot load and wipe-data alike.
const HOST_SIDE_TOOLS: ReadonlySet<string> = new Set([
  "network",
  "mockNetwork",
  "clearMockNetwork",
  "setDeviceResources",
]);
const OPAQUE_PERSISTENT_TOOLS: ReadonlySet<string> = new Set(["deviceSnapshot"]);

function activityAllowsReset(
  strategy: AndroidResetStrategy,
  activity: AndroidResetSessionActivity,
): boolean {
  return strategy.fullBaseline ? !activity.madeHostSideChanges() : activity.canReset();
}

function isStepTimeout(error: unknown): boolean {
  return isTransientAdbTimeout(error);
}

export type AndroidResetProfile = Extract<BrokerNativeProfile, { platform: "android" }>;

export interface AndroidResetSessionActivity {
  canReset(): boolean;
  /** True once the session ran a tool whose effects a snapshot load cannot revert. */
  madeOpaquePersistentChanges(): boolean;
  /** True once the session ran a tool that changes host-side state no guest reset reverts. */
  madeHostSideChanges(): boolean;
  close(): void;
}

export function watchAndroidResetSession(
  tracker: Pick<ExecutionTracker, "onSessionExecutionEnded">,
  sessionId: string,
): AndroidResetSessionActivity {
  let safe = true;
  let opaque = false;
  let hostSide = false;
  const close = tracker.onSessionExecutionEnded((sessionIds, activity) => {
    if (sessionIds.includes(sessionId) && activity.admitted) {
      safe = false;
      opaque ||= OPAQUE_PERSISTENT_TOOLS.has(activity.toolName);
      hostSide ||= HOST_SIDE_TOOLS.has(activity.toolName);
    }
  });
  return {
    canReset: () => safe,
    madeOpaquePersistentChanges: () => opaque,
    madeHostSideChanges: () => hostSide,
    close,
  };
}

export interface AndroidResetStrategy {
  readonly fullBaseline?: boolean;
  readonly handlesSessionMutations?: boolean;
  capture?(device: BootedDevice, context: AndroidResetCaptureContext): Promise<void>;
  forget?(resourceId: string): void | Promise<void>;
  reset(
    device: BootedDevice,
    baselinePackages: ReadonlySet<string>,
    assertOwned: () => Promise<void>,
    context: AndroidResetSessionContext,
  ): Promise<void | ResetOutcome>;
}

export interface AndroidResetSessionContext {
  resetTiming?: ResetOutcome;
  fresh?: boolean;
  resourceId: string;
  sessionId?: string;
  incarnation?: string;
  /** The reset restores a foldable's opened posture itself, so a journaled posture change is covered. */
  foldPostureRestored?: boolean;
  /** The session made changes a snapshot load cannot revert; only wipe-data is clean. */
  opaquePersistentChanges?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  deadlineMs?: number;
  assertOwned?(): Promise<void>;
  assertBindingOwned?(): Promise<void>;
  rebindIncarnation?(): Promise<string>;
  healthCheck?(context: DeviceMutationResetContext): Promise<void>;
}

export interface AndroidResetContext extends AndroidResetSessionContext {
  signal: AbortSignal;
  timeoutMs: number;
  assertOwned(): Promise<void>;
}

export type AndroidResetCaptureContext = AndroidResetContext;

export interface AndroidBaselineResetDependencies {
  postureReset?: AndroidFoldPostureRestore;
  inventory(options: {
    signal?: AbortSignal;
    timeoutMs: number;
    targetDeviceId: string;
  }): Promise<DeviceInfo[]>;
  adb(device: BootedDevice): AdbCommandRunner;
  watchSession(sessionId: string): AndroidResetSessionActivity;
  ctrlProxyReady(
    device: BootedDevice,
    options?: { signal?: AbortSignal; timeoutMs?: number; noRetry?: boolean },
  ): Promise<boolean>;
  strategy?: AndroidResetStrategy;
  resetTimeoutMs?: number;
  timer?: Pick<Timer, "now" | "sleep" | "setTimeout" | "clearTimeout">;
}

interface AndroidBaselineCaptureOptions {
  stableDeviceId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  timer?: Pick<Timer, "now" | "sleep" | "setTimeout" | "clearTimeout">;
  assertOwned?: () => Promise<void>;
  fresh?: boolean;
}

interface AndroidBaseline {
  device: BootedDevice;
  profile: AndroidResetProfile;
  packages: ReadonlySet<string>;
  activity: AndroidResetSessionActivity;
  sessionId: string;
  incarnation: string;
  stableDeviceId: string;
  bootId?: string;
  timer: Pick<Timer, "now" | "sleep" | "setTimeout" | "clearTimeout">;
}

interface ResetReadBudget {
  deadlineMs: number;
  timer: Pick<Timer, "now" | "sleep" | "setTimeout" | "clearTimeout">;
  assertOwned(): Promise<void>;
}

export class AndroidBaselineReset {
  private readonly baselines = new Map<string, AndroidBaseline>();

  constructor(private readonly dependencies: AndroidBaselineResetDependencies) {}

  get canCapture(): boolean {
    return this.dependencies.strategy !== undefined;
  }

  async capture(
    resourceId: string,
    device: BootedDevice,
    profile: AndroidResetProfile,
    sessionId: string,
    options: AndroidBaselineCaptureOptions,
  ): Promise<{ bootId: string | null } | undefined> {
    this.closeBaseline(resourceId);
    if (!this.dependencies.strategy) {
      return;
    }
    const activity = this.dependencies.watchSession(sessionId);
    const timer = options.timer ?? defaultTimer;
    const deadlineMs = timer.now() + (options.timeoutMs ?? 2000);
    const deadlineController = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, deadlineController.signal])
      : deadlineController.signal;
    const runStepOnce = <T>(
      operation: (timeoutMs: number) => Promise<T>,
      label: string,
      attemptsLeft?: number,
    ) => {
      signal.throwIfAborted();
      const timeoutMs = deadlineMs - timer.now();
      if (timeoutMs <= 0) {
        throw new ActionableError("Android reset baseline capture exceeded preparation deadline");
      }
      return raceWithDeadline(
        async () => {
          await options.assertOwned?.();
          signal.throwIfAborted();
          const result = await operation(
            attemptsLeft === undefined
              ? Math.min(2000, timeoutMs)
              : Math.min(timeoutMs, Math.max(2000, Math.floor(timeoutMs / attemptsLeft))),
          );
          signal.throwIfAborted();
          await options.assertOwned?.();
          return result;
        },
        {
          timer,
          timeoutMs,
          signal,
          label,
          timeoutError: () =>
            new ActionableError("Android reset baseline capture exceeded preparation deadline"),
          onTimeout: () =>
            deadlineController.abort(
              new ActionableError("Android reset baseline capture exceeded preparation deadline"),
            ),
        },
      );
    };
    // One slow adb read under host load must not discard the baseline (and with it a reusable
    // device): retry a step whose own cap expired while the preparation deadline still has room.
    const runStep = async <T>(
      operation: (timeoutMs: number) => Promise<T>,
      label: string,
      targetVerification = false,
    ): Promise<T> => {
      for (let attempt = 1; ; attempt++) {
        try {
          const attemptsLeft = targetVerification
            ? ANDROID_BASELINE_STEP_ATTEMPTS - attempt + 1
            : undefined;
          return await runStepOnce(operation, label, attemptsLeft);
        } catch (error) {
          const retry =
            attempt < ANDROID_BASELINE_STEP_ATTEMPTS &&
            !signal.aborted &&
            deadlineMs - timer.now() > 0 &&
            isStepTimeout(error);
          if (!retry) {
            throw error;
          }
          logger.warn(`${label} timed out; retrying (attempt ${attempt + 1})`);
        }
      }
    };
    try {
      await runStep(
        (timeoutMs) => this.assertTarget(device, profile, signal, timeoutMs),
        "Android reset baseline target verification",
        true,
      );
      const packages = await runStep(
        (timeoutMs) => this.packages(device, signal, timeoutMs),
        "Android reset baseline package inventory",
      );
      const bootId = this.dependencies.strategy.handlesSessionMutations
        ? await runStep(
            (timeoutMs) => this.bootIdentity(device, signal, timeoutMs),
            "Android reset boot identity",
          )
        : undefined;
      const incarnation = mutationIncarnation({
        platform: "android",
        resourceId,
        stableDeviceId: options.stableDeviceId,
        bootId: bootId ?? null,
      });
      if (this.dependencies.strategy.capture) {
        if (this.dependencies.strategy.fullBaseline && !options.assertOwned) {
          throw new ActionableError(
            "Android snapshot capture requires exclusive binding ownership",
          );
        }
        await this.dependencies.strategy.capture(device, {
          fresh: options.fresh,
          resourceId,
          sessionId,
          incarnation,
          signal,
          timeoutMs: Math.max(0, deadlineMs - timer.now()),
          assertOwned: async () => {
            await options.assertOwned?.();
            await this.assertTarget(
              device,
              profile,
              signal,
              Math.max(1, deadlineMs - timer.now()),
              { allowPendingName: true },
            );
            if (bootId) {
              await this.assertBootIdentity(device, bootId, signal);
            }
            await options.assertOwned?.();
          },
        });
      }
      this.baselines.set(resourceId, {
        device: { ...device },
        profile: { ...profile },
        packages,
        activity,
        sessionId,
        incarnation,
        stableDeviceId: options.stableDeviceId,
        bootId,
        timer,
      });
      return { bootId: bootId ?? null };
    } catch (error) {
      activity.close();
      await this.forget(resourceId);
      throw toActionableError(error, "Cannot capture Android reset baseline");
    }
  }

  async forget(resourceId: string, retire = true): Promise<void> {
    this.closeBaseline(resourceId);
    if (retire) {
      try {
        await this.dependencies.strategy?.forget?.(resourceId);
      } catch (error) {
        logger.warn("Android reset baseline pruning failed; continuing teardown", error);
      }
    }
  }

  private closeBaseline(resourceId: string): void {
    this.baselines.get(resourceId)?.activity.close();
    this.baselines.delete(resourceId);
  }

  async reset(
    resourceId: string,
    device: BootedDevice,
    profile: AndroidResetProfile,
    assertOwned: () => Promise<void>,
  ): Promise<"clean" | ResetOutcome> {
    const timing: ResetOutcome = { outcome: "pending", mode: "none", phases: {} };
    const timer = this.dependencies.timer ?? this.baselines.get(resourceId)?.timer ?? defaultTimer;
    const timeoutMs = this.dependencies.resetTimeoutMs ?? DEFAULT_ANDROID_RESET_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new ActionableError("Android reset timeout must be a positive integer in milliseconds");
    }
    const deadlineMs = timer.now() + timeoutMs;
    const controller = new AbortController();
    const ambientSignal = getAbortSignal();
    const signal = ambientSignal
      ? AbortSignal.any([ambientSignal, controller.signal])
      : controller.signal;
    const owned = async () => {
      signal.throwIfAborted();
      await assertOwned();
      signal.throwIfAborted();
    };
    try {
      return await raceWithDeadline(
        () =>
          this.resetWithinDeadline(resourceId, device, profile, owned, signal, {
            deadlineMs,
            timing,
            timer,
          }),
        {
          timer,
          timeoutMs,
          signal,
          label: "Android baseline reset",
          onTimeout: () =>
            controller.abort(new ActionableError("Android baseline reset deadline exceeded")),
        },
      );
    } catch (error) {
      controller.abort(error);
      if (error instanceof ResetFailureError) {
        throw error;
      }
      throw new ResetFailureError(
        toActionableError(error, "Android baseline reset failed").message,
        { ...timing, outcome: "pending" },
        {
          cause: error,
        },
      );
    } finally {
      this.closeBaseline(resourceId);
    }
  }

  private async restoreFoldPosture(
    device: BootedDevice,
    profile: AndroidResetProfile,
    assertOwned: () => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    if (profile.archetype === "foldable") {
      signal.throwIfAborted();
      await assertOwned();
      if (!this.dependencies.postureReset) {
        throw new ActionableError(
          `Cannot restore Android device '${device.deviceId}' to opened posture: posture reset is unavailable`,
        );
      }
      await this.dependencies.postureReset.restore(device, signal);
      signal.throwIfAborted();
      await assertOwned();
    }
  }

  private requireBaseline(
    resourceId: string,
    device: BootedDevice,
    profile: AndroidResetProfile,
  ): AndroidBaseline {
    const baseline = this.baselines.get(resourceId);
    if (
      !baseline ||
      baseline.device.deviceId !== device.deviceId ||
      baseline.device.name !== device.name ||
      baseline.profile.systemImagePackage !== profile.systemImagePackage ||
      baseline.profile.profileId !== profile.profileId ||
      baseline.profile.memoryMb !== profile.memoryMb
    ) {
      throw new ActionableError("Android reset lacks the original session baseline");
    }
    return baseline;
  }

  private async resetWithinDeadline(
    resourceId: string,
    device: BootedDevice,
    profile: AndroidResetProfile,
    assertOwned: () => Promise<void>,
    signal: AbortSignal,
    {
      deadlineMs,
      timing,
      timer,
    }: {
      deadlineMs: number;
      timing: ResetOutcome;
      timer: Pick<Timer, "now" | "sleep" | "setTimeout" | "clearTimeout">;
    },
  ): Promise<"clean" | ResetOutcome> {
    const strategy = this.dependencies.strategy;
    if (!strategy) {
      await this.forget(resourceId);
      throw new ActionableError("Android reset cannot prove restoration of unobservable state");
    }
    const baseline = this.requireBaseline(resourceId, device, profile);
    const budget: ResetReadBudget = { deadlineMs, timer, assertOwned };
    const fence = async () => {
      await assertOwned();
      if (!strategy.handlesSessionMutations && !activityAllowsReset(strategy, baseline.activity)) {
        throw new ActionableError("Android session mutations cannot be restored by this reset");
      }
      await this.assertTarget(
        device,
        profile,
        signal,
        Math.max(1, deadlineMs - timer.now()),
        {
          requireBoot: !strategy.handlesSessionMutations,
          allowPendingName: true,
        },
        budget,
      );
      if (baseline.bootId) {
        await this.assertBootIdentity(device, baseline.bootId, signal, budget);
      }
      await assertOwned();
    };
    try {
      await fence();
      if (!strategy.fullBaseline && !strategy.handlesSessionMutations) {
        await this.assertPackagesMatch(
          device,
          baseline.packages,
          "Android reset detected untracked package inventory changes",
          signal,
          budget,
        );
      }
      const healthCheck = (context?: DeviceMutationResetContext) =>
        this.healthCheck(
          device,
          profile,
          context?.signal ?? signal,
          healthReadBudget(budget, context),
        );
      const result = await strategy.reset(
        device,
        baseline.packages,
        strategy.fullBaseline
          ? async () => {
              await assertOwned();
              if (
                !strategy.handlesSessionMutations &&
                !activityAllowsReset(strategy, baseline.activity)
              ) {
                throw new ActionableError(
                  "Android session mutations cannot be restored by this reset",
                );
              }
            }
          : fence,
        {
          resourceId,
          sessionId: baseline.sessionId,
          incarnation: baseline.incarnation,
          opaquePersistentChanges: baseline.activity.madeOpaquePersistentChanges(),
          foldPostureRestored:
            profile.archetype === "foldable" && this.dependencies.postureReset !== undefined,
          signal,
          timeoutMs: deadlineMs - timer.now(),
          deadlineMs,
          assertOwned,
          assertBindingOwned: assertOwned,
          rebindIncarnation: async () => {
            await assertOwned();
            await this.assertTarget(
              device,
              profile,
              signal,
              Math.max(1, deadlineMs - timer.now()),
              { allowPendingName: true },
              budget,
            );
            const bootId = await this.bootIdentity(device, signal, undefined, budget);
            await assertOwned();
            baseline.bootId = bootId;
            baseline.incarnation = mutationIncarnation({
              platform: "android",
              resourceId,
              stableDeviceId: baseline.stableDeviceId,
              bootId: bootId ?? null,
            });
            return baseline.incarnation;
          },
          healthCheck,
          resetTiming: timing,
        },
      );
      Object.assign(timing, result);
      await fence();
      await this.restoreFoldPosture(device, profile, assertOwned, signal);
      await fence();
      if (!strategy.handlesSessionMutations) {
        await this.assertPackagesMatch(
          device,
          baseline.packages,
          "Android reset did not restore the original package inventory",
          signal,
          budget,
        );
      }
      await healthCheck();
      await fence();
      return result ?? "clean";
    } finally {
      this.closeBaseline(resourceId);
    }
  }

  private async healthCheck(
    device: BootedDevice,
    profile: AndroidResetProfile,
    signal: AbortSignal,
    budget: ResetReadBudget,
  ): Promise<void> {
    await budget.assertOwned();
    await this.assertTarget(
      device,
      profile,
      signal,
      Math.max(1, budget.deadlineMs - budget.timer.now()),
      { allowPendingName: true },
      budget,
    );
    await budget.assertOwned();
    await this.packages(device, signal, undefined, budget);
    await budget.assertOwned();
    if (!(await this.checkCtrlProxy(device, budget, signal))) {
      throw new ActionableError("Android reset CtrlProxy health check failed");
    }
    await budget.assertOwned();
  }

  private async assertTarget(
    device: BootedDevice,
    profile: AndroidResetProfile,
    signal?: AbortSignal,
    // Capture-only default; reset callers always supply an absolute read budget.
    timeoutMs = 2000,
    {
      requireBoot = true,
      allowPendingName = false,
    }: { requireBoot?: boolean; allowPendingName?: boolean } = {},
    budget?: ResetReadBudget,
  ): Promise<void> {
    const runtime = parseAndroidSystemImageRuntime(profile.systemImagePackage);
    const validInput = [
      device.platform === "android",
      /^emulator-\d+$/.test(device.deviceId),
      device.name.trim().length > 0,
      runtime?.apiLevel === profile.apiLevel,
      runtime?.abi === profile.abi,
      runtime?.tag === profile.flavor,
    ].every(Boolean);
    if (!validInput) {
      throw new ActionableError(
        "Android reset requires an exact emulator and system-image profile",
      );
    }
    const inventory = await this.readWithinBudget(
      (attemptTimeoutMs) =>
        this.dependencies.inventory({
          signal,
          timeoutMs: attemptTimeoutMs,
          targetDeviceId: device.deviceId,
        }),
      signal,
      timeoutMs,
      budget,
    );
    signal?.throwIfAborted();
    if (!inventoryProvesTarget(inventory, device, profile, allowPendingName)) {
      throw new ActionableError(
        "Fresh Android inventory did not prove the exact online reset target",
      );
    }
    if (requireBoot) {
      await this.assertBoot(device, signal, captureReadTimeout(timeoutMs, budget), budget);
    }
  }

  private async assertBoot(
    device: BootedDevice,
    signal?: AbortSignal,
    // Capture-only default; reset callers always supply an absolute read budget.
    timeoutMs = 2000,
    budget?: ResetReadBudget,
  ): Promise<void> {
    const boot = await this.readWithinBudget(
      (attemptTimeoutMs) =>
        this.dependencies.adb(device).executeCommand("shell getprop sys.boot_completed", {
          timeoutMs: attemptTimeoutMs,
          signal,
          noRetry: true,
          waitForProcessSettlementAfterAbort: true,
        }),
      signal,
      timeoutMs,
      budget,
    );
    if (boot.stdout.trim() !== "1" || outputLooksLikeShellFailure(boot.stdout, boot.stderr)) {
      throw new ActionableError("Android reset target has not completed boot");
    }
  }

  private async bootIdentity(
    device: BootedDevice,
    signal?: AbortSignal,
    // Capture-only default; reset callers always supply an absolute read budget.
    timeoutMs = 2000,
    budget?: ResetReadBudget,
  ): Promise<string> {
    signal?.throwIfAborted();
    const result = await this.readWithinBudget(
      (attemptTimeoutMs) =>
        this.dependencies.adb(device).executeCommand("shell cat /proc/sys/kernel/random/boot_id", {
          signal,
          timeoutMs: attemptTimeoutMs,
          noRetry: true,
          waitForProcessSettlementAfterAbort: true,
        }),
      signal,
      timeoutMs,
      budget,
    );
    signal?.throwIfAborted();
    const bootId = result.stdout.trim();
    if (
      result.error ||
      result.stderr.trim() ||
      !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(bootId)
    ) {
      throw new ActionableError("Android reset cannot read emulator boot identity");
    }
    return bootId;
  }

  private async assertBootIdentity(
    device: BootedDevice,
    bootId: string,
    signal?: AbortSignal,
    budget?: ResetReadBudget,
  ): Promise<void> {
    if ((await this.bootIdentity(device, signal, undefined, budget)) !== bootId) {
      throw new ActionableError("Android reset target changed emulator boot identity");
    }
  }

  private async checkCtrlProxy(
    device: BootedDevice,
    budget: ResetReadBudget,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const controller = new AbortController();
    const probeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const deadlineMs = ctrlProxyDeadlineMs(budget.timer, budget.deadlineMs);
    const failure = () => new ActionableError("Android reset CtrlProxy health check failed");
    return raceWithDeadline(
      () =>
        pollUntilWithinBudget(
          async (timeoutMs) => {
            await budget.assertOwned();
            const ready = await this.dependencies.ctrlProxyReady(device, {
              signal: probeSignal,
              timeoutMs,
              noRetry: true,
            });
            await budget.assertOwned();
            return ready;
          },
          {
            timer: budget.timer,
            deadlineMs,
            signal: probeSignal,
            label: "Android reset CtrlProxy health check",
          },
        ),
      {
        timer: budget.timer,
        timeoutMs: Math.max(0, deadlineMs - budget.timer.now()),
        signal,
        label: "Android reset CtrlProxy health check",
        timeoutError: failure,
        onTimeout: () => controller.abort(failure()),
      },
    );
  }

  private readWithinBudget<T>(
    operation: (timeoutMs: number) => Promise<T>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    budget?: ResetReadBudget,
  ): Promise<T> {
    if (!budget) {
      return operation(timeoutMs);
    }
    return retryAdbWithinBudget(
      async (attemptTimeoutMs) => {
        await budget.assertOwned();
        signal?.throwIfAborted();
        const result = await operation(attemptTimeoutMs);
        await budget.assertOwned();
        return result;
      },
      { timer: budget.timer, deadlineMs: budget.deadlineMs, signal, label: "Android reset adb" },
    );
  }

  private async assertPackagesMatch(
    device: BootedDevice,
    baseline: ReadonlySet<string>,
    message: string,
    signal?: AbortSignal,
    budget?: ResetReadBudget,
  ): Promise<void> {
    const packages = await this.packages(device, signal, undefined, budget);
    if (
      packages.size !== baseline.size ||
      [...baseline].some((packageName) => !packages.has(packageName))
    ) {
      throw new ActionableError(message);
    }
  }

  private async packages(
    device: BootedDevice,
    signal?: AbortSignal,
    // Capture-only default; reset callers always supply an absolute read budget.
    timeoutMs = 2000,
    budget?: ResetReadBudget,
  ): Promise<Set<string>> {
    const health = await this.readWithinBudget(
      (attemptTimeoutMs) =>
        this.dependencies.adb(device).executeCommand("shell pm path android", {
          timeoutMs: attemptTimeoutMs,
          signal,
          noRetry: true,
          waitForProcessSettlementAfterAbort: true,
        }),
      signal,
      timeoutMs,
      budget,
    );
    signal?.throwIfAborted();
    if (!health.stdout.trim().startsWith("package:") || health.stderr.trim()) {
      throw new ActionableError("Android reset package manager is not responsive");
    }
    const result = await this.readWithinBudget(
      (attemptTimeoutMs) =>
        this.dependencies.adb(device).executeCommand("shell pm list packages -3", {
          timeoutMs: attemptTimeoutMs,
          signal,
          noRetry: true,
          waitForProcessSettlementAfterAbort: true,
        }),
      signal,
      timeoutMs,
      budget,
    );
    signal?.throwIfAborted();
    if (result.stderr.trim() || outputLooksLikeShellFailure(result.stdout, result.stderr)) {
      throw new ActionableError("Android reset package manager is not responsive");
    }
    const packages = new Set<string>();
    for (const line of result.stdout.split("\n")) {
      const entry = line.trim();
      if (!entry) {
        continue;
      }
      if (!/^package:[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(entry)) {
        throw new ActionableError("Android reset received an invalid package inventory");
      }
      packages.add(entry.slice("package:".length));
    }
    return packages;
  }
}

function targetProvesProfile(
  target: DeviceInfo,
  device: BootedDevice,
  profile: AndroidResetProfile,
  pendingName: boolean,
): boolean {
  return [
    target.platform === "android",
    target.deviceId === device.deviceId,
    pendingName || target.name === device.name,
    target.isRunning === true,
    target.isRunningStateKnown !== false,
    pendingName || target.runtimeId === profile.systemImagePackage,
    pendingName || target.deviceType === profile.profileId,
    pendingName || target.apiLevel === profile.apiLevel,
  ].every(Boolean);
}

function inventoryProvesTarget(
  inventory: DeviceInfo[],
  device: BootedDevice,
  profile: AndroidResetProfile,
  allowPendingName: boolean,
): boolean {
  // Targeted inventory omits other serials; the emulator AVD lock prevents a second writable instance.
  const matches = inventory.filter(
    (candidate) => candidate.deviceId === device.deviceId || candidate.name === device.name,
  );
  const target = matches[0];
  if (matches.length !== 1 || !target) {
    return false;
  }
  // Console-exclusive snapshot work temporarily omits the AVD name and its config fields.
  // Only after the initial full profile proof may serial presence stand in for that profile.
  const pendingName = allowPendingName && isUnknownEmulatorName(target.name, device.deviceId);
  return targetProvesProfile(target, device, profile, pendingName);
}

function healthReadBudget(
  budget: ResetReadBudget,
  context?: DeviceMutationResetContext,
): ResetReadBudget {
  return {
    ...budget,
    deadlineMs: Math.min(budget.deadlineMs, context?.deadlineMs ?? budget.deadlineMs),
    assertOwned: context?.assertOwned ?? budget.assertOwned,
  };
}

function captureReadTimeout(timeoutMs: number, budget?: ResetReadBudget): number {
  // Capture retains its existing step cap; resets derive every attempt from the deadline.
  return budget ? timeoutMs : Math.min(2000, timeoutMs);
}
