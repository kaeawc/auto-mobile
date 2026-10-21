import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { BootedDevice } from "../../models/DeviceInfo";
import { MAX_SETTIMEOUT_DELAY_MS, type Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { combineWithAmbientAbort, runWithAbortSignal } from "../../utils/AbortContext";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import type {
  AndroidResetCaptureContext,
  AndroidResetSessionContext,
  AndroidResetStrategy,
} from "./androidBaselineReset";
import {
  captureFirstDeviceBaseline,
  type DeviceMutationResetContext,
  type DeviceMutationResetPort,
} from "./mutations/reset";
import type { ResetOutcome } from "./devicePort";
import { isAndroidCriticalSetting } from "./androidKeepBootedCleanup";
import {
  type DeviceBaseline,
  type DeviceMutationJournal,
  type DeviceMutationScope,
} from "./mutations/types";

export interface AndroidKeepBootedResetPort extends DeviceMutationResetPort {
  cleanBaseline(baseline: DeviceBaseline, context: DeviceMutationResetContext): Promise<void>;
}

export interface AndroidKeepBootedResetDependencies {
  journal: Pick<
    DeviceMutationJournal,
    "getBaseline" | "captureBaseline" | "list" | "deleteResource"
  >;
  port(device: BootedDevice): AndroidKeepBootedResetPort;
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
  maxUses?: number;
  budgetMs?: number;
  fallbackBudgetMs?: number;
  fallback?: AndroidResetStrategy;
}

interface AndroidKeepBootedSession {
  scope: DeviceMutationScope;
  uses: number;
  retired: boolean;
}

export class AndroidKeepBootedReset implements AndroidResetStrategy {
  readonly handlesSessionMutations = true;
  private readonly sessions = new Map<string, AndroidKeepBootedSession>();
  private readonly maxUses: number;
  private readonly budgetMs: number;
  private readonly fallbackBudgetMs: number;

  constructor(private readonly dependencies: AndroidKeepBootedResetDependencies) {
    this.maxUses = dependencies.maxUses ?? 20;
    this.budgetMs = dependencies.budgetMs ?? 30_000;
    this.fallbackBudgetMs = dependencies.fallbackBudgetMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.maxUses) ||
      this.maxUses <= 0 ||
      !Number.isFinite(this.budgetMs) ||
      this.budgetMs <= 0 ||
      this.budgetMs > MAX_SETTIMEOUT_DELAY_MS ||
      !Number.isFinite(this.fallbackBudgetMs) ||
      this.fallbackBudgetMs <= 0 ||
      this.fallbackBudgetMs > MAX_SETTIMEOUT_DELAY_MS
    ) {
      throw new ActionableError("Android keep-booted requires positive, bounded reset limits");
    }
  }

  async capture(device: BootedDevice, context: AndroidResetCaptureContext): Promise<void> {
    if (
      !Number.isFinite(context.timeoutMs) ||
      context.timeoutMs <= 0 ||
      context.timeoutMs > MAX_SETTIMEOUT_DELAY_MS
    ) {
      throw new ActionableError(
        "Android keep-booted capture requires a bounded preparation budget",
      );
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    const fence = async () => {
      signal.throwIfAborted();
      await context.assertOwned();
      signal.throwIfAborted();
    };
    try {
      await raceWithDeadline(
        () =>
          this.captureSession(device, {
            ...context,
            signal,
            assertOwned: fence,
          }),
        {
          timer: this.dependencies.timer,
          signal,
          timeoutMs: context.timeoutMs,
          label: "Android keep-booted baseline capture",
          onTimeout: () =>
            controller.abort(new ActionableError("Android keep-booted capture budget exceeded")),
        },
      );
    } catch (error) {
      controller.abort(error);
      await this.forget(context.resourceId);
      throw toActionableError(error, "Android keep-booted baseline capture failed");
    }
  }

  private async captureSession(
    device: BootedDevice,
    context: AndroidResetCaptureContext,
  ): Promise<void> {
    const deadlineMs = this.dependencies.timer.now() + context.timeoutMs;
    const prior = this.sessions.get(context.resourceId);
    const incarnation = context.incarnation ?? context.resourceId;
    if (
      prior &&
      (prior.scope.deviceId !== device.deviceId || prior.scope.incarnation !== incarnation)
    ) {
      throw new ActionableError("Android keep-booted resource changed emulator identity");
    }
    const scope: DeviceMutationScope = {
      deviceId: device.deviceId,
      incarnation,
      sessionUuid: context.sessionId,
    };
    const baseline = await this.dependencies.journal.getBaseline(scope);
    const port = this.dependencies.port(device);
    this.sessions.set(context.resourceId, this.nextSession(scope, prior, baseline !== null));
    if (!baseline) {
      const controller = new AbortController();
      const signal = AbortSignal.any([context.signal, controller.signal]);
      const timeoutMs = Math.min(context.timeoutMs, this.budgetMs);
      await raceWithDeadline(
        () =>
          this.captureBaseline(port, scope, {
            ...context,
            signal,
            timeoutMs,
            assertOwned: async () => {
              signal.throwIfAborted();
              await context.assertOwned();
              signal.throwIfAborted();
            },
          }),
        {
          timer: this.dependencies.timer,
          signal,
          timeoutMs,
          label: "Android keep-booted journal capture",
          onTimeout: () =>
            controller.abort(new ActionableError("Android keep-booted capture budget exceeded")),
        },
      );
    }
    await context.assertOwned();
    context.signal.throwIfAborted();
    if (!this.sessions.get(context.resourceId)?.retired) {
      await this.dependencies.fallback?.capture?.(device, {
        ...context,
        timeoutMs: deadlineMs - this.dependencies.timer.now(),
      });
    }
    await context.assertOwned();
    context.signal.throwIfAborted();
  }

  private async captureBaseline(
    port: AndroidKeepBootedResetPort,
    scope: DeviceMutationScope,
    context: AndroidResetCaptureContext,
  ): Promise<void> {
    await captureFirstDeviceBaseline(this.dependencies.journal, port, {
      scope,
      signal: context.signal,
      assertOwned: context.assertOwned,
    });
  }

  private nextSession(
    scope: DeviceMutationScope,
    prior: AndroidKeepBootedSession | undefined,
    baselineExists: boolean,
  ): AndroidKeepBootedSession {
    return {
      scope,
      uses: prior?.scope.sessionUuid === scope.sessionUuid ? prior.uses : (prior?.uses ?? 0) + 1,
      retired: prior?.retired ?? baselineExists,
    };
  }

  async forget(resourceId: string): Promise<void> {
    try {
      await this.dependencies.journal.deleteResource(resourceId);
    } catch (error) {
      logger.warn("Android keep-booted journal pruning failed; continuing teardown", error);
    }
    this.sessions.delete(resourceId);
    await this.dependencies.fallback?.forget?.(resourceId);
  }

  private resetSession(
    device: BootedDevice,
    context: AndroidResetSessionContext,
  ): AndroidKeepBootedSession {
    const session = this.sessions.get(context.resourceId);
    if (
      !session ||
      session.scope.sessionUuid !== context.sessionId ||
      session.scope.deviceId !== device.deviceId ||
      session.scope.incarnation !== (context.incarnation ?? context.resourceId)
    ) {
      throw new ActionableError("Android keep-booted lacks the fenced session baseline");
    }
    if (session.retired) {
      throw new ActionableError("Android keep-booted restart requires incarnation retirement");
    }
    return session;
  }

  async reset(
    device: BootedDevice,
    baselinePackages: ReadonlySet<string>,
    assertOwned: () => Promise<void>,
    context: AndroidResetSessionContext,
  ): Promise<ResetOutcome> {
    const session = this.resetSession(device, context);
    const port = this.dependencies.port(device);
    const controller = new AbortController();
    const signal = context.signal
      ? AbortSignal.any([context.signal, controller.signal])
      : controller.signal;
    const fence = async () => {
      signal.throwIfAborted();
      const ownershipSignal = combineWithAmbientAbort(signal);
      try {
        await runWithAbortSignal(ownershipSignal, assertOwned);
      } catch (error) {
        if (!ownershipSignal?.aborted) {
          controller.abort(error);
        }
        throw toActionableError(error, "Android keep-booted ownership fence failed");
      }
      signal.throwIfAborted();
    };
    const phases: Record<string, number> = {};
    const mutationContext: DeviceMutationResetContext = {
      scope: session.scope,
      signal,
      assertOwned: fence,
    };
    try {
      await fence();
      const reason =
        session.uses >= this.maxUses
          ? "maxUses retirement"
          : await this.cleanWithDeadline(port, mutationContext, context, phases);
      await fence();
      if (reason) {
        const fallback = this.dependencies.fallback;
        if (!fallback) {
          throw new ActionableError(
            `Android keep-booted is non-clean (${reason}); baseline fallback or destruction is required`,
          );
        }
        logger.warn(`Android keep-booted escalating to baseline (${reason})`);
        let fallbackOperation: Promise<void> | undefined;
        try {
          await raceWithDeadline(
            () => {
              fallbackOperation = this.measure("fallback", phases, async () => {
                await fallback.reset(device, baselinePackages, fence, {
                  ...context,
                  signal,
                  timeoutMs: this.fallbackBudgetMs,
                });
                await fence();
                await this.measure(
                  "health",
                  phases,
                  () => context.healthCheck?.(mutationContext) ?? Promise.resolve(),
                );
                await fence();
              });
              return fallbackOperation;
            },
            {
              timer: this.dependencies.timer,
              signal,
              timeoutMs: this.fallbackBudgetMs,
              label: "Android keep-booted fallback",
              onTimeout: () =>
                controller.abort(
                  new ActionableError("Android keep-booted fallback budget exceeded"),
                ),
            },
          );
        } catch (error) {
          controller.abort(error);
          throw error;
        } finally {
          await this.drainOperation(fallbackOperation);
        }
        await fence();
        session.uses = 0;
        return { outcome: "fallback:snapshot", mode: "snapshot", phases, fallbackReason: reason };
      }
      await fence();
      return { outcome: "clean", mode: "keep-booted", phases };
    } catch (error) {
      controller.abort(error);
      logger.warn(`Android keep-booted reset failed: ${errorMessage(error)}`, error);
      throw toActionableError(
        error,
        "Android keep-booted requires baseline fallback or destruction",
      );
    }
  }

  private async measure(
    phase: string,
    phases: Record<string, number>,
    operation: () => Promise<void>,
  ): Promise<void> {
    const started = this.dependencies.timer.now();
    try {
      await operation();
    } finally {
      phases[phase] = this.dependencies.timer.now() - started;
    }
  }

  private async cleanWithDeadline(
    port: AndroidKeepBootedResetPort,
    context: DeviceMutationResetContext,
    sessionContext: AndroidResetSessionContext,
    phases: Record<string, number>,
  ): Promise<string | undefined> {
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    const cleaningContext: DeviceMutationResetContext = {
      ...context,
      signal,
      assertOwned: async () => {
        signal.throwIfAborted();
        await runWithAbortSignal(signal, context.assertOwned);
        signal.throwIfAborted();
      },
    };
    let cleaningOperation: Promise<void> | undefined;
    try {
      await raceWithDeadline(
        () => {
          cleaningOperation = this.clean(port, cleaningContext, sessionContext, phases);
          return cleaningOperation;
        },
        {
          timer: this.dependencies.timer,
          signal,
          timeoutMs: Math.min(this.budgetMs, sessionContext.timeoutMs ?? this.budgetMs),
          label: "Android keep-booted cleaning",
          onTimeout: () =>
            controller.abort(new ActionableError("Android keep-booted cleaning budget exceeded")),
        },
      );
      return undefined;
    } catch (error) {
      controller.abort(error);
      logger.warn("Android keep-booted cleaning failed", error);
      return errorMessage(error);
    } finally {
      await this.drainOperation(cleaningOperation);
    }
  }

  private async drainOperation(operation: Promise<void> | undefined): Promise<void> {
    await raceWithDeadline(Promise.allSettled(operation ? [operation] : []), {
      timer: this.dependencies.timer,
      timeoutMs: 2000,
      label: "Android keep-booted command settlement",
    });
  }

  private async clean(
    port: AndroidKeepBootedResetPort,
    cleaningContext: DeviceMutationResetContext,
    sessionContext: AndroidResetSessionContext,
    phases: Record<string, number>,
  ): Promise<void> {
    const baseline = await this.dependencies.journal.getBaseline(cleaningContext.scope);
    if (!baseline) {
      throw new ActionableError("Android keep-booted baseline is missing");
    }
    await cleaningContext.assertOwned();
    await this.measure("journal", phases, () =>
      this.replayJournal(port, cleaningContext, baseline),
    );
    await this.measure("clean", phases, () => port.cleanBaseline(baseline, cleaningContext));
    await cleaningContext.assertOwned();
    await this.measure(
      "health",
      phases,
      () => sessionContext.healthCheck?.(cleaningContext) ?? Promise.resolve(),
    );
    await cleaningContext.assertOwned();
  }

  private async replayJournal(
    port: AndroidKeepBootedResetPort,
    context: DeviceMutationResetContext,
    baseline: DeviceBaseline,
  ): Promise<void> {
    const entries = await this.dependencies.journal.list(context.scope);
    for (const mutation of [...entries].sort((left, right) => right.sequence - left.sequence)) {
      await context.assertOwned();
      const baselinePackage =
        mutation.kind === "installed-app" &&
        mutation.priorValue.state === "absent" &&
        baseline.observations.some(
          (observation) =>
            observation.kind === mutation.kind &&
            observation.key === mutation.key &&
            observation.value.state === "present",
        );
      if (!port.canRevert(mutation) || mutation.kind === "preference" || baselinePackage) {
        logger.warn(`Android keep-booted skipped journal revert ${mutation.kind}:${mutation.key}`);
        continue;
      }
      try {
        await port.revert(mutation, context);
      } catch (error) {
        logger.warn(
          `Android keep-booted journal revert failed ${mutation.kind}:${mutation.key}`,
          error,
        );
        await context.assertOwned();
        if (mutation.kind !== "device-setting" || isAndroidCriticalSetting(mutation.key)) {
          throw error;
        }
      }
    }
  }
}
