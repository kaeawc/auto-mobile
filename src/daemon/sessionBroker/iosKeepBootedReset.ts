import type { MutationRecordingGaps } from "./mutations/recordingGaps";
import { storePreferenceCoveredByBaseline } from "./mutations/appInventory";
import {
  defaultHostLoadReader,
  loadScaledBudget,
  retryBudget,
  describeLoadScaledBudget,
  type HostLoadReader,
  type LoadScaledBudget,
} from "../../utils/hostLoadBudget";
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
  type DeviceMutationInput,
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
  sanitizeCovers(
    entry: DeviceMutationInput,
    context?: Pick<DeviceMutationResetContext, "baseline">,
  ): boolean;
  sanitize(context: DeviceMutationResetContext): Promise<void>;
}

export interface IosKeepBootedResetDependencies {
  recordingGaps?: Pick<MutationRecordingGaps, "reasonFor" | "clear">;
  journal: Pick<
    DeviceMutationJournal,
    "list" | "getBaseline" | "deleteSession" | "listStrayIncarnations"
  >;
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
  /**
   * What a non-clean release does: "erase" (default) erases and reboots the simulator;
   * "destroy" never erases, so the broker deletes the simulator and the next acquisition
   * creates a fresh one.
   */
  fallback?: "erase" | "destroy";
  budgetMs?: number;
  budgetCeilingMs?: number;
  hostLoad?: HostLoadReader;
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
  private readonly budgetTimeouts = new WeakSet<object>();
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
      const context: DeviceMutationResetContext = {
        scope,
        signal: signal ?? new AbortController().signal,
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
        this.cleaningStep(context, signal, phase, phases, operation);
      const entries = await this.loadJournal(context, step, phases);
      try {
        this.assertCompleteRecording(scope.sessionUuid);
        await step("inventory", () =>
          readExpectedIosResetTarget(
            this.dependencies.simctl,
            device.deviceId,
            profile,
            "Booted",
            "start keep-booted reset",
            { signal: context.signal, timeoutMs: this.innerReadTimeoutMs() },
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
        const strays = await this.dependencies.journal.listStrayIncarnations(context.scope);
        if (strays.length > 0) {
          throw new ActionableError(
            `iOS journaled mutations recorded under a different incarnation (${strays.length}) cannot be journal-reverted; erase required`,
          );
        }
        await this.replayJournal(entries, context, step);
        await step("sanitize", () => this.dependencies.mutations.sanitize(context));
        await owned();
        await this.checkHealth(device, profile, context, phases, signal);
      } catch (error) {
        logger.warn(`iOS keep-booted cleaning failed: ${errorMessage(error)}`, error);
        await owned();
        fallbackReason = this.fallbackReason(error);
        logger.warn(`iOS erase fallback: ${fallbackReason}`, error);
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
    return this.nonCleanOutcome(
      { device, profile, scope, assertOwned: owned, phases, signal },
      fallbackReason,
      runResetBoot,
    );
  }

  private nonCleanOutcome(
    attempt: IosResetAttempt,
    fallbackReason: string,
    runResetBoot?: ResetBootRunner,
  ): Promise<ResetOutcome> {
    return this.dependencies.fallback === "destroy"
      ? Promise.resolve(this.destroyFallback(attempt.phases, fallbackReason))
      : this.eraseFallback(attempt, fallbackReason, runResetBoot);
  }

  /**
   * A non-clean outcome sends the release down the broker's destroy path; the simulator is
   * never erased. A recorded cleaning failure stays recorded, so a redrive repeats this
   * outcome instead of cleaning a half-cleaned simulator again.
   */
  private destroyFallback(phases: Record<string, number>, fallbackReason: string): ResetOutcome {
    return { outcome: "pending", mode: "keep-booted", phases, fallbackReason };
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
      this.dependencies.recordingGaps?.clear(scope.sessionUuid);
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
    const plans = [...entries]
      .sort((left, right) => right.sequence - left.sequence)
      .map((entry) => ({
        entry,
        plan: planDeviceMutationRevert(
          [entry],
          { dirty: [], changes: [] },
          this.dependencies.mutations,
        ),
      }));
    for (const { entry, plan } of plans) {
      if (
        !["installed-app", "app-group"].includes(entry.kind) &&
        plan.status === "non_revertible" &&
        !this.sanitizeCovers(entry, context)
      ) {
        throw new ActionableError(
          `iOS journaled mutation ${entry.kind}:${entry.key} (${entry.toolName}) cannot be journal-reverted or sanitized; erase required`,
        );
      }
    }
    for (const { entry, plan } of plans) {
      if (["installed-app", "app-group"].includes(entry.kind)) {
        logger.warn(`iOS reset handles ${entry.kind}:${entry.key} through app inventory cleaning`);
        continue;
      }
      if (plan.status === "non_revertible") {
        logger.warn(`iOS reset skipped journal revert: ${plan.reasons.join("; ")}`);
        continue;
      }
      await step(`revert:${entry.kind}:${entry.key}`, () =>
        this.dependencies.mutations.revert(entry, context),
      );
    }
  }

  private assertCompleteRecording(sessionUuid: string): void {
    const gap = this.dependencies.recordingGaps?.reasonFor(sessionUuid);
    if (gap !== undefined) {
      throw new ActionableError(
        `iOS device mutation recording failed (${gap}); journal is incomplete; erase required`,
      );
    }
  }

  private sanitizeCovers(entry: DeviceMutationInput, context: DeviceMutationResetContext): boolean {
    if (entry.kind === "opaque") {
      return !opaqueForcesFallback(entry);
    }
    if (entry.kind === "preference") {
      return storePreferenceCoveredByBaseline(entry, context.baseline);
    }
    return this.dependencies.mutations.sanitizeCovers(entry, context);
  }

  /**
   * The step budget, not this read, must decide when a slow step has failed, so the
   * read is bounded by the largest budget any attempt can be given.
   */
  private innerReadTimeoutMs(): number {
    return Math.max(
      this.dependencies.budgetMs ?? 30_000,
      this.dependencies.budgetCeilingMs ?? 120_000,
    );
  }

  private fallbackReason(error: unknown): string {
    return this.isBudgetTimeout(error)
      ? `budget-driven: ${errorMessage(error)}`
      : errorMessage(error);
  }

  private isBudgetTimeout(error: unknown): boolean {
    return typeof error === "object" && error !== null && this.budgetTimeouts.has(error);
  }

  private async cleaningStep<Result>(
    context: DeviceMutationResetContext,
    callerSignal: AbortSignal | undefined,
    phase: string,
    phases: Record<string, number>,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const first = loadScaledBudget(
      {
        baseMs: this.dependencies.budgetMs ?? 30_000,
        ceilingMs: this.dependencies.budgetCeilingMs ?? 120_000,
      },
      this.dependencies.hostLoad ?? defaultHostLoadReader(),
    );
    try {
      return await this.cleaningAttempt(context, callerSignal, phase, phases, operation, {
        first,
        timeoutMs: first.budgetMs,
      });
    } catch (error) {
      if (!this.isBudgetTimeout(error) || callerSignal?.aborted) {
        throw error;
      }
      logger.warn(`Retrying iOS reset ${phase}: ${errorMessage(error)}`, error);
      await this.waitForAbandonedStep(
        context.scope.deviceId,
        retryBudget(first),
        error,
        callerSignal,
      );
      return this.cleaningAttempt(context, callerSignal, phase, phases, operation, {
        first,
        timeoutMs: retryBudget(first),
      });
    }
  }

  private async cleaningAttempt<Result>(
    context: DeviceMutationResetContext,
    callerSignal: AbortSignal | undefined,
    phase: string,
    phases: Record<string, number>,
    operation: () => Promise<Result>,
    { first, timeoutMs }: { first: LoadScaledBudget; timeoutMs: number },
  ): Promise<Result> {
    const controller = new AbortController();
    context.signal = combineAbortSignals(controller.signal, callerSignal) ?? controller.signal;
    const timeout = new DOMException(
      `iOS reset ${phase} timed out after ${timeoutMs}ms (${describeLoadScaledBudget(first)})`,
      "TimeoutError",
    );
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
        timeoutMs,
        signal: callerSignal,
        label: `iOS reset ${phase}`,
        timeoutError: () => timeout,
        onTimeout: () => {
          this.budgetTimeouts.add(timeout);
          controller.abort(timeout);
        },
      },
    );
  }

  private async waitForAbandonedStep(
    deviceId: string,
    timeoutMs: number,
    timeout: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    await raceWithDeadline(Promise.allSettled([...(this.pending.get(deviceId) ?? [])]), {
      timer: this.dependencies.timer,
      timeoutMs,
      signal,
      label: "iOS reset abandoned step settlement",
      timeoutError: () => timeout,
    });
  }

  private async checkHealth(
    device: BootedDevice,
    profile: IosResetProfile,
    context: DeviceMutationResetContext,
    phases: Record<string, number>,
    signal?: AbortSignal,
  ): Promise<void> {
    const started = this.dependencies.timer.now();
    try {
      await this.cleaningStep(context, signal, "health-probe", phases, async () => {
        await readExpectedIosResetTarget(
          this.dependencies.simctl,
          device.deviceId,
          profile,
          "Booted",
          "confirm keep-booted health",
          { signal: context.signal, timeoutMs: this.innerReadTimeoutMs() },
        );
        await context.assertOwned();
        if (!(await this.dependencies.health.probe(device, context.signal))) {
          throw new ActionableError("iOS keep-booted automation server is unhealthy");
        }
      });
    } finally {
      phases.health = (phases.health ?? 0) + this.dependencies.timer.now() - started;
    }
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
