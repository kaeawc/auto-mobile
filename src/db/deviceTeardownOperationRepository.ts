import type { Kysely } from "kysely";
import { getDatabase } from "./database";
import type { Database } from "./types";
import { logger } from "../utils/logger";

export type DeviceTeardownOperationBeginResult =
  | { status: "started" }
  | { status: "completed"; result: unknown }
  | { status: "in_progress" }
  | { status: "conflict" };

export interface DeviceTeardownOperationStore {
  begin(
    operationId: string,
    requestFingerprint: string,
    ownerToken: string,
    nowMs: number,
    expiresAtMs: number,
  ): Promise<DeviceTeardownOperationBeginResult>;
  renew(
    operationId: string,
    requestFingerprint: string,
    ownerToken: string,
    expiresAtMs: number,
  ): Promise<void>;
  complete(
    operationId: string,
    requestFingerprint: string,
    ownerToken: string,
    result: unknown,
    expiresAtMs: number,
  ): Promise<void>;
  delete(operationId: string, requestFingerprint: string, ownerToken: string): Promise<void>;
}

function decodeResult(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && "result" in parsed) {
      return (parsed as { result: unknown }).result;
    }
  } catch (error) {
    logger.warn(`[DeviceTeardownOperationRepository] Invalid stored result: ${error}`, error);
  }
  return undefined;
}

export class DeviceTeardownOperationRepository implements DeviceTeardownOperationStore {
  constructor(private readonly database?: Kysely<Database>) {}

  async begin(
    operationId: string,
    requestFingerprint: string,
    ownerToken: string,
    nowMs: number,
    expiresAtMs: number,
  ): Promise<DeviceTeardownOperationBeginResult> {
    const db = this.getDb();
    const existing = await this.read(operationId);
    if (existing && existing.expires_at_ms > nowMs) {
      return this.resolveExisting(requestFingerprint, existing);
    }
    if (existing) {
      await db
        .deleteFrom("device_teardown_operations")
        .where("operation_id", "=", operationId)
        .where("expires_at_ms", "<=", nowMs)
        .execute();
    }

    try {
      await db
        .insertInto("device_teardown_operations")
        .values({
          operation_id: operationId,
          request_fingerprint: requestFingerprint,
          owner_token: ownerToken,
          status: "running",
          result_json: null,
          expires_at_ms: expiresAtMs,
        })
        .execute();
      return { status: "started" };
    } catch (error) {
      const raced = await this.read(operationId);
      if (!raced) {
        throw new Error(`Could not persist teardown operation '${operationId}': ${error}`);
      }
      return this.resolveExisting(requestFingerprint, raced);
    }
  }

  async renew(
    operationId: string,
    requestFingerprint: string,
    ownerToken: string,
    expiresAtMs: number,
  ): Promise<void> {
    await this.getDb()
      .updateTable("device_teardown_operations")
      .set({ expires_at_ms: expiresAtMs, updated_at: new Date().toISOString() })
      .where("operation_id", "=", operationId)
      .where("request_fingerprint", "=", requestFingerprint)
      .where("owner_token", "=", ownerToken)
      .where("status", "=", "running")
      .execute();
  }

  async complete(
    operationId: string,
    requestFingerprint: string,
    ownerToken: string,
    result: unknown,
    expiresAtMs: number,
  ): Promise<void> {
    await this.getDb()
      .updateTable("device_teardown_operations")
      .set({
        status: "completed",
        result_json: JSON.stringify({ result }),
        expires_at_ms: expiresAtMs,
        updated_at: new Date().toISOString(),
      })
      .where("operation_id", "=", operationId)
      .where("request_fingerprint", "=", requestFingerprint)
      .where("owner_token", "=", ownerToken)
      .execute();
  }

  async delete(operationId: string, requestFingerprint: string, ownerToken: string): Promise<void> {
    await this.getDb()
      .deleteFrom("device_teardown_operations")
      .where("operation_id", "=", operationId)
      .where("request_fingerprint", "=", requestFingerprint)
      .where("owner_token", "=", ownerToken)
      .execute();
  }

  private async read(operationId: string) {
    return await this.getDb()
      .selectFrom("device_teardown_operations")
      .selectAll()
      .where("operation_id", "=", operationId)
      .executeTakeFirst();
  }

  private resolveExisting(
    requestFingerprint: string,
    existing: {
      request_fingerprint: string;
      owner_token: string;
      status: string;
      result_json: string | null;
    },
  ): DeviceTeardownOperationBeginResult {
    if (existing.request_fingerprint !== requestFingerprint) {
      return { status: "conflict" };
    }
    if (existing.status === "completed" && existing.result_json !== null) {
      const result = decodeResult(existing.result_json);
      if (result !== undefined) {
        return { status: "completed", result };
      }
    }
    return { status: "in_progress" };
  }

  private getDb(): Kysely<Database> {
    return this.database ?? getDatabase();
  }
}
