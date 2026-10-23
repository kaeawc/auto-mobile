import { ActionableError } from "../../models/ActionableError";
import type { BootedDevice } from "../../models/DeviceInfo";
import type { SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";
import { combineAbortSignals } from "../../utils/AbortContext";
import type { ResetOutcome, ResetBootRunner } from "./devicePort";
import { ResetFailureError } from "./ResetFailureError";
import {
  assertIosResetInput,
  readExpectedIosResetTarget,
  type IosResetProfile,
} from "./iosResetTarget";
import type { DeviceMutationResetContext, DeviceMutationResetPort } from "./mutations/reset";
import { planDeviceMutationRevert } from "./mutations/revertPlanner";
import {
  assertDeviceMutationScope,
  opaqueForcesFallback,
  type DeviceMutationEntry,
  type DeviceMutationJournal,
  type DeviceMutationScope,
} from "./mutations/types";

export interface IosResetHealthPort {
  probe(device: BootedDevice, signal: AbortSignal): Promise<boolean>;
}

export interface IosKeepBootedMutationPort extends Pick<
  DeviceMutationResetPort,
  "canRevert" | "revert"
> {
  assertSettled(context: DeviceMutationResetContext): Promise<void>;
  sanitize(context: DeviceMutationResetContext): Promise<void>;
}

export interface IosKeepBootedResetDependencies {
  journal: Pick<DeviceMutationJournal, "list" | "getBaseline" | "deleteSession">;
  mutations: IosKeepBootedMutationPort;
  simctl: Pick<SimCtl, "readSimulatorTarget">;
  health: IosResetHealthPort;
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
  erase: {
    resetWithTiming(
      device: BootedDevice,
      profile: IosResetProfile,
      assertOwned: () => Promise<void>,
      signal?: AbortSignal,
    ): Promise<ResetOutcome>;
  };
  maxUses: number;
  budgetMs?: number;
}

interface IosResetAttempt {
  device: BootedDevice;
  profile: IosResetProfile;
  scope: DeviceMutationScope;
  assertOwned: () => Promise<void>;
  phases: Record<string, number>;
  signal?: AbortSignal;
}

export class IosKeepBootedReset {
  private readonly pending = new Map<string, Set<Promise<unknown>>>();
  private readonly eraseReasons = new Map<string, string>();
  constructor(private readonly dependencies: IosKeepBootedResetDependencies) {
    if (!Number.isSafeInteger(dependencies.maxUses) || dependencies.maxUses < 1) {
      throw new ActionableError("iOS keep-booted reset maxUses must be a positive safe integer");
    }
  }

  async resetWithTiming(
    device: BootedDevice,
    profile: IosResetProfile,
    assertOwned: () => Promise<void>,
    scope: DeviceMutationScope,
    reuseCount: number,
    options: { signal?: AbortSignal; runResetBoot?: ResetBootRunner } = {},
  ): Promise<ResetOutcome> {
    const { signal, runResetBoot } = options;
    this.assertInput(device, profile, scope, reuseCount);
    const phases: Record<string, number> = {};
    const owned = async () => {
      signal?.throwIfAborted();
      await assertOwned();
      signal?.throwIfAborted();
    };
    await owned();
    await this.assertSettled(scope, owned, signal);
    const failureKey = JSON.stringify([scope.deviceId, scope.incarnation, scope.sessionUuid]);
    let fallbackReason = this.eraseReasons.get(failureKey) ?? "maxUses reached";
    if (!this.eraseReasons.has(failureKey) && (reuseCount + 1) % this.dependencies.maxUses !== 0) {
      const controller = new AbortController();
      const context: DeviceMutationResetContext = {
        scope,
        signal: combineAbortSignals(controller.signal, signal) ?? controller.signal,
        assertOwned: async () => {
          context.signal.throwIfAborted();
          await owned();
          context.signal.throwIfAborted();
        },
        recordPhase: (phase, durationMs) => {
          phases[phase] = (phases[phase] ?? 0) + durationMs;
        },
      };
      const step = <Result>(phase: string, operation: () => Promise<Result>) =>
        this.cleaningStep(context, controller, phase, phases, operation);
      const entries = await this.loadJournal(context, step, phases);
      try {
        await step("inventory", () =>
          readExpectedIosResetTarget(
            this.dependencies.simctl,
            device.deviceId,
            profile,
            "Booted",
            "start keep-booted reset",
            { signal: context.signal, timeoutMs: 10_000 },
          ),
        );
        if (!context.baseline?.completeKinds.includes("installed-app")) {
          throw new ActionableError("iOS reset requires a captured app baseline; erase required");
        }
        const opaque = entries.find(opaqueForcesFallback);
        if (opaque) {
          throw new ActionableError(
            `iOS opaque journaled mutation (${opaque.toolName}) cannot be journal-reverted; erase required`,
          );
        }
        await this.replayJournal(entries, context, step);
        await step("sanitize", () => this.dependencies.mutations.sanitize(context));
        await owned();
        await this.measure(device.deviceId, "health", phases, () =>
          this.checkHealth(device, profile, owned, phases, signal),
        );
      } catch (error) {
        logger.warn(`iOS keep-booted cleaning failed: ${errorMessage(error)}`, error);
        await owned();
        fallbackReason = errorMessage(error);
        this.eraseReasons.set(failureKey, fallbackReason);
      }
      if (!this.eraseReasons.has(failureKey)) {
        await owned();
        await this.dependencies.journal.deleteSession(scope);
        await owned();
        return { outcome: "clean", mode: "keep-booted", phases };
      }
    }
    await owned();
    await this.assertSettled(scope, owned, signal);
    return this.eraseFallback(
      { device, profile, scope, assertOwned: owned, phases, signal },
      fallbackReason,
      runResetBoot,
    );
  }

  private async eraseFallback(
    attempt: IosResetAttempt,
    fallbackReason: string,
    runResetBoot?: ResetBootRunner,
  ): Promise<ResetOutcome> {
    const { device, profile, scope, assertOwned: owned, phases, signal } = attempt;
    try {
      const operation = () =>
        this.dependencies.erase.resetWithTiming(device, profile, owned, signal);
      const erased = await (runResetBoot ? runResetBoot(operation) : operation());
      await owned();
      if (erased.outcome !== "clean") {
        throw new ActionableError("iOS erase fallback did not confirm a clean baseline");
      }
      await this.dependencies.journal.deleteSession(scope);
      await owned();
      this.eraseReasons.delete(
        JSON.stringify([scope.deviceId, scope.incarnation, scope.sessionUuid]),
      );
      return {
        outcome: "fallback:erase",
        mode: "erase",
        phases: { ...phases, ...erased.phases },
        fallbackReason,
      };
    } catch (error) {
      logger.warn(`iOS erase fallback failed: ${errorMessage(error)}`, error);
      throw new ResetFailureError(
        errorMessage(error),
        {
          outcome: "pending",
          mode: "erase",
          phases: { ...phases, ...(error instanceof ResetFailureError ? error.reset.phases : {}) },
          fallbackReason: `${fallbackReason}; erase: ${errorMessage(error)}`,
        },
        { cause: error instanceof ResetFailureError ? error.cause : error },
      );
    }
  }

  private async loadJournal(
    context: DeviceMutationResetContext,
    step: <Result>(phase: string, operation: () => Promise<Result>) => Promise<Result>,
    phases: Record<string, number>,
  ) {
    try {
      return await step("journal", async () => {
        context.baseline =
          (await this.dependencies.journal.getBaseline(context.scope)) ?? undefined;
        return this.dependencies.journal.list(context.scope);
      });
    } catch (error) {
      throw new ResetFailureError(
        errorMessage(error),
        {
          outcome: "pending",
          mode: "keep-booted",
          phases,
          fallbackReason: errorMessage(error),
        },
        { cause: error },
      );
    }
  }

  private async replayJournal(
    entries: readonly DeviceMutationEntry[],
    context: DeviceMutationResetContext,
    step: (phase: string, operation: () => Promise<void>) => Promise<void>,
  ): Promise<void> {
    for (const entry of [...entries].sort((left, right) => right.sequence - left.sequence)) {
      const plan = planDeviceMutationRevert(
        [entry],
        { dirty: [], changes: [] },
        this.dependencies.mutations,
      );
      if (plan.status === "non_revertible") {
        logger.warn(`iOS reset skipped journal revert: ${plan.reasons.join("; ")}`);
        continue;
      }
      if (["installed-app", "app-group"].includes(entry.kind)) {
        logger.warn(`iOS reset handles ${entry.kind}:${entry.key} through app inventory cleaning`);
        continue;
      }
      await step(`revert:${entry.kind}:${entry.key}`, () =>
        this.dependencies.mutations.revert(entry, context),
      );
    }
  }

  private async cleaningStep<Result>(
    context: DeviceMutationResetContext,
    controller: AbortController,
    phase: string,
    phases: Record<string, number>,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return raceWithDeadline(
      () =>
        this.measure(context.scope.deviceId, phase, phases, async () => {
          await context.assertOwned();
          const result = await operation();
          await context.assertOwned();
          return result;
        }),
      {
        timer: this.dependencies.timer,
        timeoutMs: this.dependencies.budgetMs ?? 30_000,
        label: `iOS reset ${phase}`,
        timeoutError: () => new DOMException(`iOS reset ${phase} timed out`, "TimeoutError"),
        onTimeout: () =>
          controller.abort(new DOMException(`iOS reset ${phase} budget exceeded`, "TimeoutError")),
      },
    );
  }

  private async checkHealth(
    device: BootedDevice,
    profile: IosResetProfile,
    assertOwned: () => Promise<void>,
    phases: Record<string, number>,
    signal?: AbortSignal,
  ): Promise<void> {
    const controller = new AbortController();
    const combined = combineAbortSignals(controller.signal, signal) ?? controller.signal;
    await raceWithDeadline(
      () =>
        this.measure(device.deviceId, "health-probe", phases, async () => {
          await assertOwned();
          combined.throwIfAborted();
          await readExpectedIosResetTarget(
            this.dependencies.simctl,
            device.deviceId,
            profile,
            "Booted",
            "confirm keep-booted health",
            { signal: combined, timeoutMs: 10_000 },
          );
          await assertOwned();
          combined.throwIfAborted();
          if (!(await this.dependencies.health.probe(device, combined))) {
            throw new ActionableError("iOS keep-booted automation server is unhealthy");
          }
          combined.throwIfAborted();
          await assertOwned();
        }),
      {
        timer: this.dependencies.timer,
        timeoutMs: this.dependencies.budgetMs ?? 30_000,
        label: "iOS reset health",
        onTimeout: () =>
          controller.abort(new DOMException("iOS reset health budget exceeded", "TimeoutError")),
      },
    ).catch((error: unknown) => {
      throw new ResetFailureError(
        errorMessage(error),
        { outcome: "pending", mode: "keep-booted", phases: {} },
        { cause: controller.signal.reason ?? error },
      );
    });
  }

  private async measure<Result>(
    deviceId: string,
    phase: string,
    phases: Record<string, number>,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const started = this.dependencies.timer.now();
    const operationPromise = Promise.resolve().then(operation);
    const pending = this.pending.get(deviceId) ?? new Set<Promise<unknown>>();
    this.pending.set(deviceId, pending);
    pending.add(operationPromise);
    try {
      return await operationPromise;
    } finally {
      pending.delete(operationPromise);
      if (pending.size === 0) {
        this.pending.delete(deviceId);
      }
      phases[phase] = (phases[phase] ?? 0) + this.dependencies.timer.now() - started;
    }
  }

  private assertInput(
    device: BootedDevice,
    profile: IosResetProfile,
    scope: DeviceMutationScope,
    reuseCount: number,
  ): void {
    assertIosResetInput(device, profile);
    assertDeviceMutationScope(scope, scope.sessionUuid);
    if (device.deviceId !== scope.deviceId || !Number.isSafeInteger(reuseCount) || reuseCount < 0) {
      throw new ActionableError(
        "iOS keep-booted reset requires the exact mutation scope and durable use count",
      );
    }
  }

  private async assertSettled(
    scope: DeviceMutationScope,
    assertOwned: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      if (this.pending.has(scope.deviceId)) {
        throw new DOMException("iOS reset still has an unsettled native step", "TimeoutError");
      }
      await this.dependencies.mutations.assertSettled({
        scope,
        assertOwned,
        signal: signal ?? new AbortController().signal,
      });
    } catch (error) {
      throw new ResetFailureError(
        errorMessage(error),
        { outcome: "pending", mode: "keep-booted", phases: {} },
        { cause: error },
      );
    }
  }
}
