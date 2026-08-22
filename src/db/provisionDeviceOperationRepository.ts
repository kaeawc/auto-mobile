import type { Kysely } from "kysely";
import { getDatabase } from "./database";
import type { Database } from "./types";
import { logger } from "../utils/logger";

export interface ProvisionDeviceOperationStore {
  begin(
    operationId: string,
    requestFingerprint: string,
  ): Promise<
    | { started: true; reconcileExistingConfiguration: boolean }
    | {
      started: false;
      result: Record<string, unknown>;
      reconcileExistingConfiguration: boolean;
    }
  >;
  markDeviceCreationStarted(operationId: string): Promise<void>;
  complete(operationId: string, result: Record<string, unknown>): Promise<void>;
  fail(operationId: string, errorCode: string, message: string): Promise<void>;
}

export class ProvisionDeviceOperationConflictError extends Error {
  constructor(operationId: string) {
    super(`operationId '${operationId}' was already used for a different provisionDevice request`);
    this.name = "ProvisionDeviceOperationConflictError";
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
  ): Promise<
    | { started: true; reconcileExistingConfiguration: boolean }
    | {
      started: false;
      result: Record<string, unknown>;
      reconcileExistingConfiguration: boolean;
    }
  > {
    const db = this.getDb();
    const existing = await db
      .selectFrom("provision_device_operations")
      .selectAll()
      .where("operation_id", "=", operationId)
      .executeTakeFirst();

    if (existing) {
      return this.resolveExisting(operationId, requestFingerprint, existing);
    }

    try {
      await db
        .insertInto("provision_device_operations")
        .values({
          operation_id: operationId,
          request_fingerprint: requestFingerprint,
          status: "running",
          result_json: null,
          error_code: null,
          error_message: null,
          creation_started: 0,
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
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return this.resolveExisting(operationId, requestFingerprint, raced);
    }
  }

  async complete(operationId: string, result: Record<string, unknown>): Promise<void> {
    await this.getDb()
      .updateTable("provision_device_operations")
      .set({
        status: "succeeded",
        result_json: JSON.stringify({ result }),
        error_code: null,
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .where("operation_id", "=", operationId)
      .execute();
  }

  async markDeviceCreationStarted(operationId: string): Promise<void> {
    await this.getDb()
      .updateTable("provision_device_operations")
      .set({
        creation_started: 1,
        updated_at: new Date().toISOString(),
      })
      .where("operation_id", "=", operationId)
      .execute();
  }

  async fail(operationId: string, errorCode: string, message: string): Promise<void> {
    await this.getDb()
      .updateTable("provision_device_operations")
      .set({
        status: "failed",
        error_code: errorCode,
        error_message: message,
        updated_at: new Date().toISOString(),
      })
      .where("operation_id", "=", operationId)
      .execute();
  }

  private getDb(): Kysely<Database> {
    return this.database ?? getDatabase();
  }

  private resolveExisting(
    operationId: string,
    requestFingerprint: string,
    existing: {
      request_fingerprint: string;
      status: string;
      result_json: string | null;
      error_code: string | null;
      error_message: string | null;
      creation_started: number;
    },
  ):
    | { started: true; reconcileExistingConfiguration: boolean }
    | {
      started: false;
      result: Record<string, unknown>;
      reconcileExistingConfiguration: boolean;
    } {
    if (existing.request_fingerprint !== requestFingerprint) {
      throw new ProvisionDeviceOperationConflictError(operationId);
    }
    if (existing.status === "succeeded" && existing.result_json) {
      const result = decodeResult(existing.result_json);
      if (result) {
        return {
          started: false,
          result,
          reconcileExistingConfiguration: existing.creation_started === 1,
        };
      }
    }
    return {
      started: true,
      reconcileExistingConfiguration: existing.creation_started === 1,
    };
  }
}
