import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { BootedDevice, DeviceInfo } from "../../models/DeviceInfo";
import type { AdbCommandRunner } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { parseAndroidSystemImageRuntime } from "../../utils/android-cmdline-tools/AndroidSystemImageRuntime";
import { outputLooksLikeShellFailure } from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { BrokerNativeProfile } from "./profile";
import type { ExecutionTracker } from "../executionTracker";

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
  reset(
    device: BootedDevice,
    baselinePackages: ReadonlySet<string>,
    assertOwned: () => Promise<void>,
  ): Promise<void>;
}

export interface AndroidBaselineResetDependencies {
  inventory(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<DeviceInfo[]>;
  adb(device: BootedDevice): AdbCommandRunner;
  watchSession(sessionId: string): AndroidResetSessionActivity;
  ctrlProxyReady(device: BootedDevice): Promise<boolean>;
  strategy?: AndroidResetStrategy;
}

interface AndroidBaseline {
  device: BootedDevice;
  profile: AndroidResetProfile;
  packages: ReadonlySet<string>;
  activity: AndroidResetSessionActivity;
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
    } = {},
  ): Promise<void> {
    this.forget(resourceId);
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
      return raceWithDeadline(() => operation(Math.min(2000, timeoutMs)), {
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
      });
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
      this.baselines.set(resourceId, {
        device: { ...device },
        profile: { ...profile },
        packages,
        activity,
      });
    } catch (error) {
      activity.close();
      throw toActionableError(error, "Cannot capture Android reset baseline");
    }
  }

  forget(resourceId: string): void {
    this.baselines.get(resourceId)?.activity.close();
    this.baselines.delete(resourceId);
  }

  async reset(
    resourceId: string,
    device: BootedDevice,
    profile: AndroidResetProfile,
    assertOwned: () => Promise<void>,
  ): Promise<"clean"> {
    if (!this.dependencies.strategy) {
      this.forget(resourceId);
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
      if (!baseline.activity.canReset()) {
        throw new ActionableError("Android session mutations cannot be restored by this reset");
      }
      await this.assertTarget(device, profile);
      await assertOwned();
    };
    try {
      await fence();
      await this.assertPackagesMatch(
        device,
        baseline.packages,
        "Android reset detected untracked package inventory changes",
      );
      await this.dependencies.strategy.reset(device, baseline.packages, fence);
      await fence();
      await this.assertPackagesMatch(
        device,
        baseline.packages,
        "Android reset did not restore the original package inventory",
      );
      if (!(await this.dependencies.ctrlProxyReady(device))) {
        throw new ActionableError("Android reset CtrlProxy health check failed");
      }
      await fence();
      return "clean";
    } catch (error) {
      throw toActionableError(error, "Android baseline reset failed");
    } finally {
      this.forget(resourceId);
    }
  }

  private async assertTarget(
    device: BootedDevice,
    profile: AndroidResetProfile,
    signal?: AbortSignal,
    timeoutMs = 2000,
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
    const matches = inventory.filter(
      (candidate) => candidate.deviceId === device.deviceId || candidate.name === device.name,
    );
    const target = matches[0];
    if (matches.length !== 1 || !target) {
      throw new ActionableError(
        "Fresh Android inventory did not prove the exact online reset target",
      );
    }
    const validTarget = [
      target.platform === "android",
      target.deviceId === device.deviceId,
      target.name === device.name,
      target.isRunning === true,
      target.isRunningStateKnown !== false,
      target.runtimeId === profile.systemImagePackage,
      target.deviceType === profile.profileId,
      target.apiLevel === profile.apiLevel,
    ].every(Boolean);
    if (!validTarget) {
      throw new ActionableError(
        "Fresh Android inventory did not prove the exact online reset target",
      );
    }
    const boot = await this.dependencies
      .adb(device)
      .executeCommand("shell getprop sys.boot_completed", {
        timeoutMs,
        signal,
      });
    if (boot.stdout.trim() !== "1" || outputLooksLikeShellFailure(boot.stdout, boot.stderr)) {
      throw new ActionableError("Android reset target has not completed boot");
    }
  }

  private async assertPackagesMatch(
    device: BootedDevice,
    baseline: ReadonlySet<string>,
    message: string,
  ): Promise<void> {
    const packages = await this.packages(device);
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
    });
    signal?.throwIfAborted();
    if (!health.stdout.trim().startsWith("package:") || health.stderr.trim()) {
      throw new ActionableError("Android reset package manager is not responsive");
    }
    const result = await this.dependencies.adb(device).executeCommand("shell pm list packages -3", {
      timeoutMs,
      signal,
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
