import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { BootedDevice } from "../../models/DeviceInfo";
import type {
  BootCapacityReserver,
  BootSlotReservation,
} from "../../devices/bootAdmission/BootSlotReservation";
import type { Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { logger } from "../../utils/logger";
import type { VmSnapshotAction } from "../../utils/android-cmdline-tools/vmSnapshot";
import type {
  AndroidResetCaptureContext,
  AndroidResetSessionContext,
  AndroidResetStrategy,
} from "./androidBaselineReset";
import type { DeviceIncarnationInvalidator } from "../deviceSnapshotIncarnationInvalidator";
import type { ResetOutcome } from "./devicePort";
import { ResetFailureError } from "./ResetFailureError";
import { errorMessage } from "../../utils/describeUnknownError";

export interface AndroidSnapshotIdentity {
  avdName: string;
  systemImage: string;
  emulatorVersion: string;
  ctrlProxyVersion: string;
}

export interface AndroidSnapshotStep {
  signal: AbortSignal;
  timeoutMs: number;
  assertOwned(): Promise<void>;
}

export interface AndroidSnapshotResetPort extends BootCapacityReserver {
  identity(device: BootedDevice, step: AndroidSnapshotStep): Promise<AndroidSnapshotIdentity>;
  snapshot(
    action: VmSnapshotAction,
    device: BootedDevice,
    step: AndroidSnapshotStep,
  ): Promise<void>;
  health(device: BootedDevice, step: AndroidSnapshotStep): Promise<void>;
  stop(device: BootedDevice, step: AndroidSnapshotStep): Promise<void>;
  launchWiped(device: BootedDevice, step: AndroidSnapshotStep): Promise<void>;
  ready(device: BootedDevice, step: AndroidSnapshotStep): Promise<void>;
  waitForRestore(device: BootedDevice, step: AndroidSnapshotStep): Promise<void>;
}

interface SnapshotBaseline {
  deviceId: string;
  identity: AndroidSnapshotIdentity;
}

type RunSnapshotStep = <Result>(
  label: string,
  operation: (step: AndroidSnapshotStep) => Promise<Result>,
) => Promise<Result>;

export class AndroidSnapshotReset implements AndroidResetStrategy {
  readonly fullBaseline = true;
  private readonly baselines = new Map<string, SnapshotBaseline>();

  constructor(
    private readonly port: AndroidSnapshotResetPort,
    private readonly timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">,
    private readonly incarnation: DeviceIncarnationInvalidator,
  ) {}

  forget(resourceId: string): void {
    this.baselines.delete(resourceId);
  }

  capture(device: BootedDevice, context: AndroidResetCaptureContext): Promise<void> {
    return this.bounded(context, async (run) => {
      const identity = await run("identity", (step) => this.port.identity(device, step));
      const previous = this.baselines.get(context.resourceId);
      if (previous?.deviceId === device.deviceId && this.matches(previous.identity, identity)) {
        return;
      }
      if (context.fresh !== true) {
        throw new ActionableError(
          "Android baseline capture requires a freshly created emulator, not unqualified adoption",
        );
      }
      this.forget(context.resourceId);
      if (previous) {
        await run("invalidate", (step) => this.port.snapshot("delete", device, step));
      }
      await this.save(device, context.resourceId, identity, run);
    });
  }

  reset(
    device: BootedDevice,
    _baselinePackages: ReadonlySet<string>,
    assertOwned: () => Promise<void>,
    context: AndroidResetSessionContext,
  ): Promise<ResetOutcome> {
    const timing: ResetOutcome = context.resetTiming ?? {
      outcome: "pending",
      mode: "snapshot",
      phases: {},
    };
    timing.mode = "snapshot";
    return this.bounded({ ...context, assertOwned, resetTiming: timing }, async (run) => {
      const baseline = this.baselines.get(context.resourceId);
      try {
        const identity = await run("identity", (step) => this.port.identity(device, step));
        if (
          !baseline ||
          baseline.deviceId !== device.deviceId ||
          !this.matches(baseline.identity, identity)
        ) {
          throw new ActionableError("Android snapshot baseline is missing or incompatible");
        }
        await this.changeIncarnation(device, run, async (invalidate) => {
          await run("load", (step) => this.port.snapshot("load", device, step));
          await invalidate();
          await run("restore readiness", (step) => this.port.waitForRestore(device, step));
          await run("health", (step) => this.port.health(device, step));
          const restored = await run("restored identity", (step) =>
            this.port.identity(device, step),
          );
          if (!this.matches(identity, restored)) {
            throw new ActionableError("Android snapshot restored an incompatible identity");
          }
        });
        timing.outcome = "clean";
        return timing;
      } catch (error) {
        logger.warn("Android snapshot reset unavailable; attempting wipe-data replacement", error);
        timing.mode = "wipe-data";
        timing.fallbackReason = errorMessage(error);
      }
      this.forget(context.resourceId);
      if (baseline) {
        try {
          await run("invalidate", (step) => this.port.snapshot("delete", device, step));
        } catch (error) {
          logger.warn(
            "Android baseline invalidation failed; never reload it, require wipe-data",
            error,
          );
        }
      }
      let reservation: BootSlotReservation | undefined;
      try {
        await run("reserve replacement boot", async (step) => {
          reservation = await this.port.reserveBoot({
            replacingDeviceId: device.deviceId,
            signal: step.signal,
            timeoutMs: step.timeoutMs,
          });
          try {
            await step.assertOwned();
          } catch (error) {
            reservation.release();
            throw toActionableError(error, "Android replacement boot lost ownership");
          }
        });
        if (!reservation) {
          throw new ActionableError("Android replacement boot was not reserved");
        }
        const held = reservation;
        await held.run(() => this.replace(device, context.resourceId, run, held));
      } finally {
        reservation?.release();
      }
      timing.outcome = "fallback:wipe-data";
      return timing;
    });
  }

  private replace(
    device: BootedDevice,
    resourceId: string,
    run: RunSnapshotStep,
    reservation: BootSlotReservation,
  ): Promise<void> {
    return this.changeIncarnation(device, run, async (invalidate) => {
      await run("stop", (step) => this.port.stop(device, step));
      await invalidate();
      reservation.markReplacedDeviceGone();
      await run("wipe-data launch", (step) => this.port.launchWiped(device, step));
      await run("readiness", (step) => this.port.ready(device, step));
      await run("wipe-data health", (step) => this.port.health(device, step));
      const identity = await run("wipe-data identity", (step) => this.port.identity(device, step));
      await this.save(device, resourceId, identity, run);
    });
  }

  private async changeIncarnation(
    device: BootedDevice,
    run: RunSnapshotStep,
    operation: (invalidate: () => Promise<void>) => Promise<void>,
  ): Promise<void> {
    let prepared = false;
    let ready = false;
    let invalidated = false;
    const invalidate = async () => {
      if (!invalidated) {
        invalidated = true;
        await this.incarnation.invalidate(device);
      }
    };
    try {
      await run("prepare incarnation", async () => {
        prepared = true;
        await this.incarnation.prepareForIncarnationChange(device);
      });
      await operation(invalidate);
      ready = true;
    } finally {
      if (prepared) {
        try {
          await invalidate();
        } finally {
          await this.incarnation.settleIncarnationChange(device, { ready });
        }
      }
    }
  }

  private async save(
    device: BootedDevice,
    resourceId: string,
    identity: AndroidSnapshotIdentity,
    run: RunSnapshotStep,
  ): Promise<void> {
    await run("save", (step) => this.port.snapshot("save", device, step));
    const verified = await run("saved identity", (step) => this.port.identity(device, step));
    if (!this.matches(identity, verified)) {
      throw new ActionableError("Android baseline identity changed during snapshot capture");
    }
    this.baselines.set(resourceId, { deviceId: device.deviceId, identity: { ...identity } });
  }

  private matches(left: AndroidSnapshotIdentity, right: AndroidSnapshotIdentity): boolean {
    return (
      left.avdName === right.avdName &&
      left.systemImage === right.systemImage &&
      left.emulatorVersion === right.emulatorVersion &&
      left.ctrlProxyVersion === right.ctrlProxyVersion
    );
  }

  private async bounded<Result>(
    context: AndroidResetSessionContext,
    operation: (run: RunSnapshotStep) => Promise<Result>,
  ): Promise<Result> {
    const timing = context.resetTiming;
    const controller = new AbortController();
    const signal = context.signal
      ? AbortSignal.any([controller.signal, context.signal])
      : controller.signal;
    const timeoutMs = context.timeoutMs ?? 0;
    const deadlineMs = this.timer.now() + timeoutMs;
    const assertOwned = async () => {
      signal.throwIfAborted();
      await context.assertOwned?.();
      signal.throwIfAborted();
    };
    const run: RunSnapshotStep = async (label, nativeStep) => {
      const started = this.timer.now();
      try {
        const timeoutMs = deadlineMs - this.timer.now();
        if (timeoutMs <= 0) {
          throw new ActionableError("Android snapshot reset deadline exceeded");
        }
        return await raceWithDeadline(
          async () => {
            await assertOwned();
            const result = await nativeStep({ signal, timeoutMs, assertOwned });
            await assertOwned();
            return result;
          },
          {
            timer: this.timer,
            timeoutMs,
            signal,
            label: `Android snapshot ${label}`,
            timeoutError: () => new ActionableError("Android snapshot reset deadline exceeded"),
            onTimeout: () =>
              controller.abort(new ActionableError("Android snapshot reset deadline exceeded")),
          },
        );
      } finally {
        if (timing) {
          timing.phases[label] = (timing.phases[label] ?? 0) + this.timer.now() - started;
        }
      }
    };
    try {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !context.assertOwned) {
        throw new ActionableError("Android snapshot reset requires a finite positive deadline");
      }
      return await operation(run);
    } catch (error) {
      controller.abort(error);
      if (timing) {
        throw new ResetFailureError(
          toActionableError(error, "Android snapshot baseline reset failed; destroy required")
            .message,
          { ...timing, outcome: "pending" },
          { cause: error },
        );
      }
      throw toActionableError(error, "Android snapshot baseline reset failed; destroy required");
    }
  }
}
