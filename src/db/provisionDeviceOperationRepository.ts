import { errorMessage } from "../utils/describeUnknownError";
import type { Kysely } from "kysely";
import { getDatabase } from "./database";
import type { Database } from "./types";
import { logger } from "../utils/logger";

export type ProvisionDeviceOperationBeginResult =
  | { started: true; reconcileExistingConfiguration: boolean }
  | {
      started: false;
      result: Record<string, unknown>;
      reconcileExistingConfiguration: boolean;
    }
  | { started: false; inProgress: true };

/**
 * One row per idempotency key, fenced by an ATTEMPT token so a stale attempt
 * cannot write over the attempt that replaced it. `begin()` is a
 * compare-and-set: it admits an attempt only by moving the row to `running`
 * under its own `attemptId`, and every later mutation matches on that token.
 * Each mutation returns whether it actually changed a row -- `false` means the
 * caller was superseded and must not report success.
 */
export interface ProvisionDeviceOperationStore {
  begin(
    operationId: string,
    requestFingerprint: string,
    attemptId: string,
    nowMs: number,
    expiresAtMs: number,
  ): Promise<ProvisionDeviceOperationBeginResult>;
  markDeviceCreationStarted(operationId: string, attemptId: string): Promise<boolean>;
  complete(
    operationId: string,
    attemptId: string,
    result: Record<string, unknown>,
  ): Promise<boolean>;
  fail(
    operationId: string,
    attemptId: string,
    errorCode: string,
    message: string,
    options?: { clearCreationStarted?: boolean },
  ): Promise<boolean>;
}

export class ProvisionDeviceOperationConflictError extends Error {
  constructor(operationId: string) {
    super(`operationId '${operationId}' was already used for a different provisionDevice request`);
    this.name = "ProvisionDeviceOperationConflictError";
  }
}

export class ProvisionDeviceOperationSupersededError extends Error {
  constructor(operationId: string) {
    super(
      `operationId '${operationId}' was taken over by a newer provisionDevice attempt; this ` +
        "attempt's result was discarded",
    );
    this.name = "ProvisionDeviceOperationSupersededError";
  }
}

export class ProvisionDeviceOperationInProgressError extends Error {
  constructor(operationId: string) {
    super(
      `operationId '${operationId}' is still being provisioned by an earlier attempt with no ` +
        "terminal result yet; wait for it to finish or retry with a new operationId",
    );
    this.name = "ProvisionDeviceOperationInProgressError";
  }
}

interface StoredResult {
  result: Record<string, unknown>;
}

function decodeResult(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      "result" in parsed &&
      typeof (parsed as StoredResult).result === "object" &&
      (parsed as StoredResult).result !== null
    ) {
      return (parsed as StoredResult).result;
    }
  } catch (error) {
    logger.warn(`[ProvisionDeviceOperationRepository] Invalid stored result: ${error}`);
  }
  return undefined;
}

export class ProvisionDeviceOperationRepository implements ProvisionDeviceOperationStore {
  constructor(private readonly database?: Kysely<Database>) {}

  async begin(
    operationId: string,
    requestFingerprint: string,
    attemptId: string,
    nowMs: number,
    expiresAtMs: number,
  ): Promise<ProvisionDeviceOperationBeginResult> {
    const db = this.getDb();
    // Prune expired rows before the lookup (mirrors
    // DeviceTeardownOperationRepository.begin(), deviceTeardownOperationRepository.ts:59):
    // this both bounds table growth (#6652) and is how a genuinely abandoned
    // "running" row (its owning process crashed before complete()/fail() ran)
    // ages out into a fresh start, distinct from a still-live running row.
    await db
      .deleteFrom("provision_device_operations")
      .where("expires_at_ms", "<=", nowMs)
      .execute();
    const existing = await db
      .selectFrom("provision_device_operations")
      .selectAll()
      .where("operation_id", "=", operationId)
      .executeTakeFirst();

    if (existing) {
      return await this.resolveExisting(
        operationId,
        requestFingerprint,
        attemptId,
        expiresAtMs,
        existing,
      );
    }

    try {
      await db
        .insertInto("provision_device_operations")
        .values({
          operation_id: operationId,
          request_fingerprint: requestFingerprint,
          attempt_id: attemptId,
          status: "running",
          result_json: null,
          error_code: null,
          error_message: null,
          creation_started: 0,
          expires_at_ms: expiresAtMs,
        })
        .execute();
      return { started: true, reconcileExistingConfiguration: false };
    } catch (error) {
      const raced = await db
        .selectFrom("provision_device_operations")
        .selectAll()
        .where("operation_id", "=", operationId)
        .executeTakeFirst();
      if (!raced) {
        throw new Error(
          `Could not create provisionDevice operation '${operationId}': ` +
            `${errorMessage(error)}`,
        );
      }
      return await this.resolveExisting(
        operationId,
        requestFingerprint,
        attemptId,
        expiresAtMs,
        raced,
      );
    }
  }

  async complete(
    operationId: string,
    attemptId: string,
    result: Record<string, unknown>,
  ): Promise<boolean> {
    const update = await this.getDb()
      .updateTable("provision_device_operations")
      .set({
        status: "succeeded",
        result_json: JSON.stringify({ result }),
        error_code: null,
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .where("operation_id", "=", operationId)
      .where("attempt_id", "=", attemptId)
      .executeTakeFirst();
    return Number(update.numUpdatedRows) > 0;
  }

  async markDeviceCreationStarted(operationId: string, attemptId: string): Promise<boolean> {
    const update = await this.getDb()
      .updateTable("provision_device_operations")
      .set({
        creation_started: 1,
        updated_at: new Date().toISOString(),
      })
      .where("operation_id", "=", operationId)
      .where("attempt_id", "=", attemptId)
      .executeTakeFirst();
    return Number(update.numUpdatedRows) > 0;
  }

  async fail(
    operationId: string,
    attemptId: string,
    errorCode: string,
    message: string,
    options?: { clearCreationStarted?: boolean },
  ): Promise<boolean> {
    const update = await this.getDb()
      .updateTable("provision_device_operations")
      .set({
        status: "failed",
        error_code: errorCode,
        error_message: message,
        ...(options?.clearCreationStarted ? { creation_started: 0 } : {}),
        updated_at: new Date().toISOString(),
      })
      .where("operation_id", "=", operationId)
      .where("attempt_id", "=", attemptId)
      .executeTakeFirst();
    return Number(update.numUpdatedRows) > 0;
  }

  private getDb(): Kysely<Database> {
    return this.database ?? getDatabase();
  }

  private async resolveExisting(
    operationId: string,
    requestFingerprint: string,
    attemptId: string,
    expiresAtMs: number,
    existing: {
      request_fingerprint: string;
      attempt_id: string;
      status: string;
      result_json: string | null;
      error_code: string | null;
      error_message: string | null;
      creation_started: number;
    },
  ): Promise<ProvisionDeviceOperationBeginResult> {
    if (existing.request_fingerprint !== requestFingerprint) {
      throw new ProvisionDeviceOperationConflictError(operationId);
    }
    if (existing.status === "succeeded" && existing.result_json) {
      const result = decodeResult(existing.result_json);
      if (result) {
        // A replay still writes to this row (cutout backfill, session rebind),
        // so it has to take the fence as well -- otherwise its own complete()
        // would be rejected as superseded. Claiming is a compare-and-set on
        // the token just read, so two concurrent replays cannot both own it.
        const claimed = await this.claim(
          operationId,
          attemptId,
          expiresAtMs,
          existing,
          "succeeded",
        );
        if (!claimed) {
          return { started: false, inProgress: true };
        }
        return {
          started: false,
          result,
          reconcileExistingConfiguration: existing.creation_started === 1,
        };
      }
    }
    // A "running" row that survived the expiry sweep above is still within its
    // TTL, so a prior attempt (this process or another) may genuinely be
    // executing it right now. Report in-progress rather than silently
    // re-entering the provisioning lifecycle (#6652 defect 1) -- unlike
    // "failed", which stays retryable immediately.
    if (existing.status === "running") {
      return { started: false, inProgress: true };
    }
    // Admission is a compare-and-set, not a read-then-hope: the retry only
    // starts if it can move the row to "running" under its own fence. That
    // both stops a second retry from being admitted alongside this one (the
    // in-memory operation map is process-local, so the row is the only thing
    // serializing separate processes) and refreshes the TTL so it measures
    // THIS attempt's runtime instead of the first attempt's.
    const admitted = await this.claim(operationId, attemptId, expiresAtMs, existing, "running");
    if (!admitted) {
      return { started: false, inProgress: true };
    }
    return {
      started: true,
      reconcileExistingConfiguration: existing.creation_started === 1,
    };
  }

  /**
   * Take ownership of an existing row for `attemptId`, moving it to `status`
   * and refreshing its expiry. Conditioned on the fence and status just read,
   * so a concurrent claim of the same row loses and gets 0 updated rows.
   */
  private async claim(
    operationId: string,
    attemptId: string,
    expiresAtMs: number,
    existing: { attempt_id: string; status: string },
    status: "running" | "succeeded",
  ): Promise<boolean> {
    const update = await this.getDb()
      .updateTable("provision_device_operations")
      .set({
        status,
        attempt_id: attemptId,
        expires_at_ms: expiresAtMs,
        ...(status === "running" ? { error_code: null, error_message: null } : {}),
        updated_at: new Date().toISOString(),
      })
      .where("operation_id", "=", operationId)
      .where("attempt_id", "=", existing.attempt_id)
      .where("status", "=", existing.status)
      .executeTakeFirst();
    return Number(update.numUpdatedRows) > 0;
  }
}
