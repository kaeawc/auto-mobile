import type { ViewHierarchyResult } from "../models/ViewHierarchyResult";
import {
  centerOfBounds,
  findSystemUiAnrDialog,
  type SystemUiAnrDialog,
} from "../utils/androidSystemUiAnr";
import type { Timer } from "../utils/SystemTimer";
import type { ReadinessAttemptContext } from "./RunnerReadinessAttemptContext";
import type { ReadinessClient } from "./RunnerReadinessService";
import type { ReadinessPhaseRunner } from "./ReadinessPhaseRunner";
import { normalizeDiagnostic } from "./runnerReadinessDiagnosticText";
import { SystemUiAnrRecoveryRequiredError } from "./SystemUiAnrRecoveryRequiredError";

export const SYSTEM_UI_ANR_RECOVERY_POLL_MS = 1_000;
const SYSTEM_UI_ANR_RECOVERY_HEALTHY_POLLS = 2;
const SYSTEM_UI_ANR_RECOVERY_TIMEOUT_MS = 5_000;

interface SystemUiAnrReadinessClient {
  getAccessibilityHierarchy: NonNullable<ReadinessClient["getAccessibilityHierarchy"]>;
  requestTapCoordinates: NonNullable<ReadinessClient["requestTapCoordinates"]>;
}

/** Selects "Wait" on a System UI ANR dialog and confirms it stays dismissed. */
export class SystemUiAnrRecovery {
  constructor(
    private readonly timer: Timer,
    private readonly phases: ReadinessPhaseRunner,
  ) {}

  async recoverIfPresent(context: ReadinessAttemptContext, client: ReadinessClient): Promise<void> {
    const anrClient = this.systemUiAnrClient(context, client);
    if (!anrClient) {
      return;
    }

    const recoveryDeadlineMs = Math.min(
      context.healthDeadlineMs ?? context.totalDeadlineMs,
      this.timer.now() + SYSTEM_UI_ANR_RECOVERY_TIMEOUT_MS,
    );
    const initialHierarchy = await this.readSystemUiAnrHierarchy(
      context,
      anrClient,
      recoveryDeadlineMs,
    );
    const dialog = findSystemUiAnrDialog(initialHierarchy ?? { hierarchy: {} });
    if (!dialog) {
      return;
    }

    await this.selectSystemUiAnrWait(context, anrClient, dialog.waitBounds, recoveryDeadlineMs);
    await this.waitForSystemUiAnrRecovery(
      context,
      anrClient,
      recoveryDeadlineMs,
      initialHierarchy?.updatedAt,
    );
  }

  private systemUiAnrClient(
    context: ReadinessAttemptContext,
    client: ReadinessClient,
  ): SystemUiAnrReadinessClient | undefined {
    if (
      context.device.platform !== "android" ||
      !client.getAccessibilityHierarchy ||
      !client.requestTapCoordinates
    ) {
      return undefined;
    }
    return {
      getAccessibilityHierarchy: (...args) => client.getAccessibilityHierarchy!(...args),
      requestTapCoordinates: (...args) => client.requestTapCoordinates!(...args),
    };
  }

  private async readSystemUiAnrHierarchy(
    context: ReadinessAttemptContext,
    client: SystemUiAnrReadinessClient,
    recoveryDeadlineMs: number,
    minTimestamp = 0,
    required = false,
  ): Promise<ViewHierarchyResult | null> {
    const timeoutMs = Math.min(
      this.phases.probeTimeout(context),
      this.remainingSystemUiAnrRecoveryBudget(recoveryDeadlineMs),
    );
    if (timeoutMs <= 0) {
      this.phases.throwIfCallerCancelled(context);
      if (!required) {
        return null;
      }
      throw this.systemUiAnrRecoveryRequired(
        context,
        "recovery budget expired before the dialog state could be confirmed",
      );
    }
    try {
      const hierarchy = await this.phases.runPhase(
        context,
        "runner-health",
        1,
        async (signal) =>
          await client.getAccessibilityHierarchy(undefined, {
            skipWaitForFresh: true,
            minTimestamp,
            disableAllFiltering: true,
            signal,
            timeoutMs,
          }),
      );
      // The production client can fall back to a cached tree when both its
      // fresh-data wait and synchronous request fail. A required read must not
      // treat that stale tree as confirmation that the dialog cleared.
      const isUnavailable = this.isSystemUiAnrHierarchyUnavailable(hierarchy, minTimestamp);
      if (isUnavailable && required) {
        throw this.systemUiAnrRecoveryRequired(
          context,
          "could not confirm dialog recovery: hierarchy unavailable",
        );
      }
      return isUnavailable ? null : hierarchy;
    } catch (error) {
      if (error instanceof SystemUiAnrRecoveryRequiredError) {
        throw error;
      }
      // Genuine cancellation or device loss aborts the request signal. Treating
      // that as "no dialog" would let startDevice bind a session after the
      // caller has already given up, so propagate it on every probe.
      this.phases.throwIfCallerCancelled(context, error);
      if (!required) {
        return null;
      }
      throw this.systemUiAnrRecoveryRequired(
        context,
        `could not confirm dialog recovery: ${normalizeDiagnostic(error)}`,
      );
    }
  }

  private isSystemUiAnrHierarchyUnavailable(
    hierarchy: ViewHierarchyResult | null,
    minTimestamp: number,
  ): boolean {
    if (hierarchy === null || hierarchy.fresh === false) {
      return true;
    }
    return hierarchy.updatedAt !== undefined && hierarchy.updatedAt < minTimestamp;
  }

  private async selectSystemUiAnrWait(
    context: ReadinessAttemptContext,
    client: SystemUiAnrReadinessClient,
    bounds: SystemUiAnrDialog["waitBounds"],
    recoveryDeadlineMs: number,
  ): Promise<void> {
    const { x, y } = centerOfBounds(bounds);
    try {
      const tap = await this.phases.runPhase(
        context,
        "runner-health",
        1,
        async () =>
          await client.requestTapCoordinates({
            x,
            y,
            duration: 10,
            timeoutMs: Math.min(
              this.phases.probeTimeout(context),
              this.remainingSystemUiAnrRecoveryBudget(recoveryDeadlineMs),
            ),
          }),
      );
      if (!tap.success) {
        throw new Error(tap.error ?? "unknown tap failure");
      }
    } catch (error) {
      this.phases.throwIfCallerCancelled(context, error);
      throw this.systemUiAnrRecoveryRequired(
        context,
        `could not select Wait: ${normalizeDiagnostic(error)}`,
      );
    }
  }

  private async waitForSystemUiAnrRecovery(
    context: ReadinessAttemptContext,
    client: SystemUiAnrReadinessClient,
    recoveryDeadlineMs: number,
    initialUpdatedAt: number | undefined,
  ): Promise<void> {
    let healthyPolls = 0;
    let freshAfter = (initialUpdatedAt ?? 0) + 1;
    while (this.remainingSystemUiAnrRecoveryBudget(recoveryDeadlineMs) > 0) {
      await this.timer.sleep(
        Math.min(
          SYSTEM_UI_ANR_RECOVERY_POLL_MS,
          this.remainingSystemUiAnrRecoveryBudget(recoveryDeadlineMs),
        ),
      );
      const hierarchy = await this.readSystemUiAnrHierarchy(
        context,
        client,
        recoveryDeadlineMs,
        freshAfter,
        true,
      );
      freshAfter = Math.max(freshAfter, (hierarchy?.updatedAt ?? 0) + 1);
      if (findSystemUiAnrDialog(hierarchy ?? { hierarchy: {} })) {
        healthyPolls = 0;
        continue;
      }
      healthyPolls++;
      if (healthyPolls >= SYSTEM_UI_ANR_RECOVERY_HEALTHY_POLLS) {
        return;
      }
    }

    throw this.systemUiAnrRecoveryRequired(context, "dialog persisted after selecting Wait");
  }

  private remainingSystemUiAnrRecoveryBudget(recoveryDeadlineMs: number): number {
    return Math.max(0, recoveryDeadlineMs - this.timer.now());
  }

  private systemUiAnrRecoveryRequired(
    context: ReadinessAttemptContext,
    detail: string,
  ): SystemUiAnrRecoveryRequiredError {
    return new SystemUiAnrRecoveryRequiredError(this.systemUiAnrDiagnostic(context, detail));
  }

  private systemUiAnrDiagnostic(context: ReadinessAttemptContext, detail: string): string {
    return (
      `System UI ANR recovery required: platform=android requested=[${context.requestedIdentity}] ` +
      `resolved=[${context.device.name} (${context.device.deviceId})]: ${detail}`
    );
  }
}
