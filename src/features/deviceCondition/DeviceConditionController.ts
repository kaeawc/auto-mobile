import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { OwedResetError } from "./OwedResetError";
import {
  DEVICE_CONDITION_SCHEMA_VERSION,
  DEVICE_CONDITION_UNSET,
  deviceConditionChanges,
  type DeviceConditionChange,
  type DeviceConditionChangeResult,
  type DeviceConditionInput,
  type DeviceConditionKey,
  type DeviceConditionResult,
  type DeviceConditionSignalResult,
  type DeviceConditionRestoreFailure,
  type DeviceConditionRestoreReport,
} from "./DeviceConditionTypes";

/**
 * One injector's contract (#14047). An injector owns a single condition key. It
 * applies a value, hands back a reset the controller runs later, and reads the
 * key back so release can verify a clean device. Injectors land in later children
 * (#14060, #14062, #14063, …); until then the controller has none and every
 * condition value is `"unset"`.
 */
export interface DeviceConditionInjector {
  readonly key: DeviceConditionKey;
  /**
   * Put the device into `value`. Returns a `reset` the controller runs on
   * release/expiry/reset, or null when the value was a no-op (already in that
   * state). Throwing surfaces as an `unsupported` change with the error text.
   */
  apply(
    value: string,
    signal?: AbortSignal,
    params?: Record<string, unknown>,
  ): Promise<DeviceConditionApplyOutcome>;
  /** Read whether the key is back to its clean baseline; used to verify restore. */
  isClean(signal?: AbortSignal): Promise<boolean>;
}

export interface DeviceConditionApplyOutcome {
  /** How the request resolved, mirrored into the per-change result. */
  status: "applied" | "unchanged";
  signals?: DeviceConditionSignalResult[];
  detail?: string;
  /** Run on restore; absent when nothing changed. Idempotent. */
  reset?: (signal?: AbortSignal) => Promise<void>;
}

/** A reset the controller still owes, newest registered last. */
interface RegisteredReset {
  key: DeviceConditionKey;
  reset: (signal?: AbortSignal) => Promise<void>;
  isClean: (signal?: AbortSignal) => Promise<boolean>;
}

/**
 * Holds the conditions applied on one device and restores them on demand. One
 * controller per device per session; the session layer (#14050 wiring) registers
 * its restore with release/rebind/expiry exactly like `networkCondition`.
 *
 * The controller is injector-agnostic: it is constructed with a resolver that maps
 * a condition key to its injector, so children add injectors without touching this
 * class. With no injector for a key, a non-`unset` value is reported `unsupported`
 * rather than silently dropped, and `unset` is a no-op.
 */
export class DeviceConditionController {
  /** Applied resets, in application order; restore runs them in reverse. */
  private readonly resets: RegisteredReset[] = [];

  constructor(
    private readonly resolveInjector: (
      key: DeviceConditionKey,
    ) => DeviceConditionInjector | undefined,
  ) {}

  /** Keys with a reset still owed, in application order. */
  activeKeys(): DeviceConditionKey[] {
    // A key can hold more than one reset (see clearKey); it is still one active condition.
    return [...new Set(this.resets.map((entry) => entry.key))];
  }

  hasActiveConditions(): boolean {
    return this.resets.length > 0;
  }

  /**
   * Apply one request's changes. `unset` clears a previously applied condition
   * (running just that key's reset); any other value is handed to the key's
   * injector. A reset in the same request runs first, so `{ reset: true }` plus
   * new fields is "restore everything, then apply these".
   */
  async apply(input: DeviceConditionInput, signal?: AbortSignal): Promise<DeviceConditionResult> {
    const changeResults: DeviceConditionChangeResult[] = [];
    let restore: DeviceConditionRestoreReport | undefined;
    if (input.reset === true) {
      restore = await this.restore(signal);
    }
    for (const change of deviceConditionChanges(input)) {
      changeResults.push(await this.applyChange(change, signal));
    }
    const failed = changeResults.some((result) => result.status === "unsupported");
    return {
      success: !failed && (restore?.verifiedClean ?? true),
      version: DEVICE_CONDITION_SCHEMA_VERSION,
      changes: changeResults,
      ...(restore ? { restore } : {}),
      active: this.activeKeys(),
    };
  }

  private async applyChange(
    change: DeviceConditionChange,
    signal?: AbortSignal,
  ): Promise<DeviceConditionChangeResult> {
    if (change.value === DEVICE_CONDITION_UNSET) {
      return this.clearKey(change.key, signal);
    }
    const injector = this.resolveInjector(change.key);
    if (!injector) {
      return {
        key: change.key,
        status: "unsupported",
        detail: `No injector is registered for '${change.key}'. This condition is not available yet.`,
      };
    }
    try {
      const outcome = await injector.apply(change.value, signal, change.params);
      if (outcome.reset) {
        this.resets.push({
          key: change.key,
          reset: outcome.reset,
          isClean: (s) => injector.isClean(s),
        });
      }
      return {
        key: change.key,
        status: outcome.status,
        ...(outcome.signals ? { signals: outcome.signals } : {}),
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      };
    } catch (error) {
      if (error instanceof OwedResetError) {
        // The injector left partial state it could not undo; keep the reset so release retries it.
        this.resets.push({
          key: change.key,
          reset: error.owedReset,
          isClean: (s) => injector.isClean(s),
        });
      }
      logger.warn(
        `[deviceCondition] applying ${change.key}=${change.value} failed: ${errorMessage(error)}`,
        error,
      );
      return { key: change.key, status: "unsupported", detail: errorMessage(error) };
    }
  }

  /**
   * Run and drop every reset registered for one key, newest first; a key with none is
   * `unchanged`. An injector cannot always tell whether the controller still holds its earlier
   * reset, so a key can have more than one, and clearing it must leave none behind. A reset that
   * fails stays registered (with the older ones) so a later restore still owes it.
   */
  private async clearKey(
    key: DeviceConditionKey,
    signal?: AbortSignal,
  ): Promise<DeviceConditionChangeResult> {
    const entries = this.resets.filter((entry) => entry.key === key);
    if (entries.length === 0) {
      return { key, status: "unchanged" };
    }
    for (const entry of entries.reverse()) {
      try {
        await entry.reset(signal);
        this.drop(entry);
      } catch (error) {
        logger.warn(`[deviceCondition] clearing ${key} failed: ${errorMessage(error)}`, error);
        return { key, status: "unsupported", detail: `Failed to clear: ${errorMessage(error)}` };
      }
    }
    return { key, status: "cleared" };
  }

  /**
   * Restore every applied condition, newest first, then verify each key reads
   * clean. A failed reset keeps its entry so the caller (release health marker)
   * knows the device is still dirty. This is what the session layer runs on
   * release/rebind/lease expiry.
   */
  async restore(signal?: AbortSignal): Promise<DeviceConditionRestoreReport> {
    const restored: DeviceConditionKey[] = [];
    const failures: DeviceConditionRestoreFailure[] = [];
    // Reverse order: the last condition applied is undone first.
    for (const entry of [...this.resets].reverse()) {
      try {
        await entry.reset(signal);
        const clean = await entry.isClean(signal);
        if (clean) {
          restored.push(entry.key);
          this.drop(entry);
        } else {
          failures.push({ key: entry.key, error: "reset ran but the device did not read clean" });
        }
      } catch (error) {
        logger.warn(
          `[deviceCondition] reset for ${entry.key} failed: ${errorMessage(error)}`,
          error,
        );
        failures.push({ key: entry.key, error: errorMessage(error) });
      }
    }
    return { restored, failures, verifiedClean: failures.length === 0 && this.resets.length === 0 };
  }

  private drop(entry: RegisteredReset): void {
    const index = this.resets.indexOf(entry);
    if (index !== -1) {
      this.resets.splice(index, 1);
    }
  }
}
