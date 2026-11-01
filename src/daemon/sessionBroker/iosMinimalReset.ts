import { IOS_FILES_FIXTURE_BUNDLE_ID } from "../../constants/iosFilesFixture";
import { ActionableError } from "../../models/ActionableError";
import type { BootedDevice } from "../../models/DeviceInfo";
import type { SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { combineAbortSignals } from "../../utils/AbortContext";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";
import type { ResetOutcome } from "./devicePort";
import { assertIosResetInput, type IosResetProfile } from "./iosResetTarget";
import { isUserFilesScopedKey } from "./mutations/appContainerFileKey";
import type { MutationRecordingGaps } from "./mutations/recordingGaps";
import type { DeviceMutationResetContext, DeviceMutationResetPort } from "./mutations/reset";
import {
  assertDeviceMutationScope,
  type DeviceMutationInput,
  type DeviceMutationJournal,
  type DeviceMutationScope,
} from "./mutations/types";

/**
 * The pool-entry baseline: the broker only pools simulators it created, so they enter the pool
 * with simulator defaults. Journaled priors are often unobservable, so these are written
 * unconditionally rather than replayed from the journal.
 */
const POOL_ENTRY_APPEARANCE = "light";
const POOL_ENTRY_CONTENT_SIZE = "large";
const EMPTY_PASTEBOARD: DeviceMutationInput = {
  kind: "clipboard",
  key: "pasteboard",
  priorValue: { state: "present", value: "" },
  toolName: "minimal-reset",
};
const DEFAULT_STEP_BUDGET_MS = 30_000;
const SIMCTL_STEP_TIMEOUT_MS = 10_000;

export interface IosMinimalResetDependencies {
  recordingGaps?: Pick<MutationRecordingGaps, "reasonFor" | "clear">;
  journal: Pick<DeviceMutationJournal, "list" | "deleteSession">;
  mutations: Pick<DeviceMutationResetPort, "revert">;
  simctl: Pick<SimCtl, "executeCommandArgs">;
  timer: Pick<Timer, "setTimeout" | "clearTimeout">;
  /** Every release whose 1-based use count is a multiple of this retires the simulator. */
  maxUses: number;
  budgetMs?: number;
}

/**
 * Release cleaning for `reuse.ios.mode: "minimal"` (#14682): the simulator stays Booted and a
 * short, fixed list of resets runs instead of the keep-booted baseline diff. There is NO erase
 * or reboot fallback: any failed or unsafe step returns `pending`, which makes the broker
 * destroy the simulator, so a half-cleaned device is never reused.
 *
 * Steps, in order: terminate+uninstall each app the session installed (journaled
 * `installed-app`), uninstall the managed Files fixture if user_files were staged,
 * `simctl keychain reset`, `simctl privacy reset all`, then set appearance and
 * content size back to the pool-entry defaults and empty the pasteboard.
 */
export class IosMinimalReset {
  private readonly failures = new Map<string, string>();

  constructor(private readonly dependencies: IosMinimalResetDependencies) {
    if (!Number.isSafeInteger(dependencies.maxUses) || dependencies.maxUses < 1) {
      throw new ActionableError("iOS minimal reset maxUses must be a positive safe integer");
    }
  }

  async resetWithTiming(
    device: BootedDevice,
    profile: IosResetProfile,
    assertOwned: () => Promise<void>,
    {
      scope,
      reuseCount,
      signal,
    }: { reuseCount: number; signal?: AbortSignal } & { scope: DeviceMutationScope },
  ): Promise<ResetOutcome> {
    assertIosResetInput(device, profile);
    assertDeviceMutationScope(scope, scope.sessionUuid);
    if (device.deviceId !== scope.deviceId || !Number.isSafeInteger(reuseCount) || reuseCount < 0) {
      throw new ActionableError(
        "iOS minimal reset requires the exact mutation scope and durable use count",
      );
    }
    const phases: Record<string, number> = {};
    const failureKey = JSON.stringify([scope.deviceId, scope.incarnation, scope.sessionUuid]);
    // A recorded failure stays recorded: a redrive must not clean a half-cleaned simulator again.
    const recorded = this.failures.get(failureKey);
    if (recorded !== undefined) {
      return this.pending(phases, recorded);
    }
    if ((reuseCount + 1) % this.dependencies.maxUses === 0) {
      return this.pending(phases, "maxUses reached");
    }
    try {
      await this.clean(scope, assertOwned, phases, signal);
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      // Lost ownership is not a cleaning failure: surface it instead of destroying a foreign device.
      await assertOwned();
      const reason = errorMessage(error);
      logger.warn(`iOS minimal cleaning failed; simulator will be destroyed: ${reason}`, error);
      this.failures.set(failureKey, reason);
      return this.pending(phases, reason);
    }
    await assertOwned();
    await this.dependencies.journal.deleteSession(scope);
    await assertOwned();
    this.dependencies.recordingGaps?.clear(scope.sessionUuid);
    return { outcome: "clean", mode: "minimal", phases };
  }

  private pending(phases: Record<string, number>, fallbackReason: string): ResetOutcome {
    return { outcome: "pending", mode: "minimal", phases, fallbackReason };
  }

  private async clean(
    scope: DeviceMutationScope,
    assertOwned: () => Promise<void>,
    phases: Record<string, number>,
    callerSignal?: AbortSignal,
  ): Promise<void> {
    const gap = this.dependencies.recordingGaps?.reasonFor(scope.sessionUuid);
    if (gap !== undefined) {
      throw new ActionableError(
        `iOS device mutation recording failed (${gap}); the session's apps are unknown`,
      );
    }
    const entries = [...(await this.dependencies.journal.list(scope))].sort(
      (left, right) => right.sequence - left.sequence,
    );
    const udid = scope.deviceId;
    const step = (
      phase: string,
      operation: (context: DeviceMutationResetContext) => Promise<void>,
    ) => this.step({ scope, assertOwned, phases, callerSignal }, phase, operation);
    for (const entry of entries.filter((candidate) => candidate.kind === "installed-app")) {
      await step(`uninstall:${entry.key}`, (context) =>
        this.dependencies.mutations.revert(entry, context),
      );
    }
    if (entries.some((entry) => entry.kind === "shared-file" && isUserFilesScopedKey(entry.key))) {
      // The fixture install is not journaled; uninstalling it also removes Documents/automobile.
      await step("files-fixture", (context) =>
        this.simctl(["uninstall", udid, IOS_FILES_FIXTURE_BUNDLE_ID], context),
      );
    }
    await step("keychain", (context) => this.simctl(["keychain", udid, "reset"], context));
    await step("privacy", (context) => this.simctl(["privacy", udid, "reset", "all"], context));
    await step("appearance", (context) =>
      this.simctl(["ui", udid, "appearance", POOL_ENTRY_APPEARANCE], context),
    );
    await step("content-size", (context) =>
      this.simctl(["ui", udid, "content_size", POOL_ENTRY_CONTENT_SIZE], context),
    );
    await step("pasteboard", (context) =>
      this.dependencies.mutations.revert(EMPTY_PASTEBOARD, context),
    );
  }

  private async simctl(args: string[], context: DeviceMutationResetContext): Promise<void> {
    const result = await this.dependencies.simctl.executeCommandArgs(
      args,
      SIMCTL_STEP_TIMEOUT_MS,
      context.signal,
    );
    if (result.error) {
      if (
        args[0] === "uninstall" &&
        /\b(?:app|application)\b[^\n]*\bis not installed\b/i.test(
          `${result.error}\n${result.stderr}`,
        )
      ) {
        // An already-absent fixture also has no staged files left to expose.
        logger.debug("iOS minimal reset Files fixture already absent", result.error);
        return;
      }
      throw new ActionableError(`iOS minimal reset ${args[0]} failed: ${result.error}`);
    }
  }

  private async step(
    {
      scope,
      assertOwned,
      phases,
      callerSignal,
    }: {
      scope: DeviceMutationScope;
      assertOwned: () => Promise<void>;
      phases: Record<string, number>;
      callerSignal: AbortSignal | undefined;
    },
    phase: string,
    operation: (context: DeviceMutationResetContext) => Promise<void>,
  ): Promise<void> {
    const controller = new AbortController();
    const signal = combineAbortSignals(controller.signal, callerSignal) ?? controller.signal;
    const timeoutMs = this.dependencies.budgetMs ?? DEFAULT_STEP_BUDGET_MS;
    const context: DeviceMutationResetContext = {
      scope,
      signal,
      assertOwned: async () => {
        signal.throwIfAborted();
        await assertOwned();
        signal.throwIfAborted();
      },
      recordPhase: (name, durationMs) => {
        phases[name] = (phases[name] ?? 0) + durationMs;
      },
    };
    await raceWithDeadline(
      async () => {
        await context.assertOwned();
        await operation(context);
        await context.assertOwned();
      },
      {
        timer: this.dependencies.timer,
        timeoutMs,
        signal: callerSignal,
        label: `iOS minimal reset ${phase}`,
        timeoutError: () =>
          new DOMException(
            `iOS minimal reset ${phase} timed out after ${timeoutMs}ms`,
            "TimeoutError",
          ),
        onTimeout: () => controller.abort(),
      },
    );
  }
}
