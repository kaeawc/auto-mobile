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

export type AndroidResetProfile = Extract<BrokerNativeProfile, { platform: "android" }>;

export interface AndroidResetSessionActivity {
  canReset(): boolean;
  close(): void;
}

export function watchAndroidResetSession(
  tracker: Pick<ExecutionTracker, "onSessionExecutionEnded">,
  sessionId: string,
): AndroidResetSessionActivity {
  let safe = true;
  const close = tracker.onSessionExecutionEnded((sessionIds, activity) => {
    if (sessionIds.includes(sessionId) && activity.admitted) {
      safe = false;
    }
  });
  return { canReset: () => safe, close };
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
  inventory(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<DeviceInfo[]>;
  adb(device: BootedDevice): AdbCommandRunner;
  watchSession(sessionId: string): AndroidResetSessionActivity;
  ctrlProxyReady(
    device: BootedDevice,
    options?: { signal?: AbortSignal; timeoutMs?: number; noRetry?: boolean },
  ): Promise<boolean>;
  strategy?: AndroidResetStrategy;
  resetTimeoutMs?: number;
  timer?: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
}

interface AndroidBaseline {
  device: BootedDevice;
  profile: AndroidResetProfile;
  packages: ReadonlySet<string>;
  activity: AndroidResetSessionActivity;
  sessionId: string;
  incarnation: string;
  incarnationKey: string;
  bootId?: string;
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
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
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      timer?: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
      assertOwned?: () => Promise<void>;
      fresh?: boolean;
      incarnation?: string;
    } = {},
  ): Promise<void> {
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
    const runStep = <T>(operation: (timeoutMs: number) => Promise<T>, label: string) => {
      signal.throwIfAborted();
      const timeoutMs = deadlineMs - timer.now();
      if (timeoutMs <= 0) {
        throw new ActionableError("Android reset baseline capture exceeded preparation deadline");
      }
      return raceWithDeadline(
        async () => {
          await options.assertOwned?.();
          signal.throwIfAborted();
          const result = await operation(Math.min(2000, timeoutMs));
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
    try {
      await runStep(
        (timeoutMs) => this.assertTarget(device, profile, signal, timeoutMs),
        "Android reset baseline target verification",
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
      const incarnationKey = options.incarnation ?? resourceId;
      const incarnation = JSON.stringify([resourceId, incarnationKey, bootId]);
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
            await this.assertTarget(device, profile, signal, 2000, { allowPendingName: true });
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
        incarnationKey,
        bootId,
        timer,
      });
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
      timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
    },
  ): Promise<"clean" | ResetOutcome> {
    const strategy = this.dependencies.strategy;
    if (!strategy) {
      await this.forget(resourceId);
      throw new ActionableError("Android reset cannot prove restoration of unobservable state");
    }
    const baseline = this.baselines.get(resourceId);
    if (
      !baseline ||
      baseline.device.deviceId !== device.deviceId ||
      baseline.device.name !== device.name ||
      baseline.profile.systemImagePackage !== profile.systemImagePackage ||
      baseline.profile.profileId !== profile.profileId
    ) {
      throw new ActionableError("Android reset lacks the original session baseline");
    }
    const fence = async () => {
      await assertOwned();
      if (!strategy.handlesSessionMutations && !baseline.activity.canReset()) {
        throw new ActionableError("Android session mutations cannot be restored by this reset");
      }
      await this.assertTarget(device, profile, signal, 2000, {
        requireBoot: !strategy.handlesSessionMutations,
        allowPendingName: true,
      });
      if (baseline.bootId) {
        await this.assertBootIdentity(device, baseline.bootId, signal);
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
        );
      }
      const healthCheck = async (context?: DeviceMutationResetContext) => {
        await context?.assertOwned();
        await this.assertTarget(device, profile, context?.signal ?? signal, 2000, {
          allowPendingName: true,
        });
        await context?.assertOwned();
        await this.packages(device, context?.signal ?? signal);
        await context?.assertOwned();
        if (!(await this.checkCtrlProxy(device, timer, context?.signal ?? signal))) {
          throw new ActionableError("Android reset CtrlProxy health check failed");
        }
        await context?.assertOwned();
      };
      const result = await strategy.reset(
        device,
        baseline.packages,
        strategy.fullBaseline
          ? async () => {
              await assertOwned();
              if (!strategy.handlesSessionMutations && !baseline.activity.canReset()) {
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
          signal,
          timeoutMs: deadlineMs - timer.now(),
          deadlineMs,
          assertOwned,
          assertBindingOwned: assertOwned,
          rebindIncarnation: async () => {
            await assertOwned();
            await this.assertTarget(device, profile, signal, 2000, { allowPendingName: true });
            const bootId = await this.bootIdentity(device, signal);
            await assertOwned();
            baseline.bootId = bootId;
            baseline.incarnation = JSON.stringify([resourceId, baseline.incarnationKey, bootId]);
            return baseline.incarnation;
          },
          healthCheck,
          resetTiming: timing,
        },
      );
      Object.assign(timing, result);
      await fence();
      if (!strategy.handlesSessionMutations) {
        await this.assertPackagesMatch(
          device,
          baseline.packages,
          "Android reset did not restore the original package inventory",
          signal,
        );
      }
      await healthCheck();
      await fence();
      return result ?? "clean";
    } finally {
      this.closeBaseline(resourceId);
    }
  }

  private async assertTarget(
    device: BootedDevice,
    profile: AndroidResetProfile,
    signal?: AbortSignal,
    timeoutMs = 2000,
    {
      requireBoot = true,
      allowPendingName = false,
    }: { requireBoot?: boolean; allowPendingName?: boolean } = {},
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
    const inventory = await this.dependencies.inventory({ signal, timeoutMs });
    signal?.throwIfAborted();
    if (!inventoryProvesTarget(inventory, device, profile, allowPendingName)) {
      throw new ActionableError(
        "Fresh Android inventory did not prove the exact online reset target",
      );
    }
    if (requireBoot) {
      await this.assertBoot(device, signal, timeoutMs);
    }
  }

  private async assertBoot(
    device: BootedDevice,
    signal?: AbortSignal,
    timeoutMs = 2000,
  ): Promise<void> {
    const boot = await this.dependencies
      .adb(device)
      .executeCommand("shell getprop sys.boot_completed", {
        timeoutMs,
        signal,
        noRetry: true,
        waitForProcessSettlementAfterAbort: true,
      });
    if (boot.stdout.trim() !== "1" || outputLooksLikeShellFailure(boot.stdout, boot.stderr)) {
      throw new ActionableError("Android reset target has not completed boot");
    }
  }

  private async bootIdentity(
    device: BootedDevice,
    signal?: AbortSignal,
    timeoutMs = 2000,
  ): Promise<string> {
    signal?.throwIfAborted();
    const result = await this.dependencies
      .adb(device)
      .executeCommand("shell cat /proc/sys/kernel/random/boot_id", {
        signal,
        timeoutMs,
        noRetry: true,
        waitForProcessSettlementAfterAbort: true,
      });
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
  ): Promise<void> {
    if ((await this.bootIdentity(device, signal)) !== bootId) {
      throw new ActionableError("Android reset target changed emulator boot identity");
    }
  }

  private async checkCtrlProxy(
    device: BootedDevice,
    timer: Pick<Timer, "setTimeout" | "clearTimeout">,
    parentSignal?: AbortSignal,
  ): Promise<boolean> {
    const controller = new AbortController();
    const signal = parentSignal
      ? AbortSignal.any([parentSignal, controller.signal])
      : controller.signal;
    return raceWithDeadline(
      () => this.dependencies.ctrlProxyReady(device, { signal, timeoutMs: 2000, noRetry: true }),
      {
        timer,
        signal,
        timeoutMs: 2000,
        label: "Android reset CtrlProxy health check",
        onTimeout: () =>
          controller.abort(new ActionableError("Android reset CtrlProxy health check timed out")),
      },
    );
  }

  private async assertPackagesMatch(
    device: BootedDevice,
    baseline: ReadonlySet<string>,
    message: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const packages = await this.packages(device, signal);
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
    timeoutMs = 2000,
  ): Promise<Set<string>> {
    const health = await this.dependencies.adb(device).executeCommand("shell pm path android", {
      timeoutMs,
      signal,
      noRetry: true,
      waitForProcessSettlementAfterAbort: true,
    });
    signal?.throwIfAborted();
    if (!health.stdout.trim().startsWith("package:") || health.stderr.trim()) {
      throw new ActionableError("Android reset package manager is not responsive");
    }
    const result = await this.dependencies.adb(device).executeCommand("shell pm list packages -3", {
      timeoutMs,
      signal,
      noRetry: true,
      waitForProcessSettlementAfterAbort: true,
    });
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
