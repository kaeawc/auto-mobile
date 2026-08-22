import type {
  DeviceTeardownOperationBeginResult,
  DeviceTeardownOperationStore,
} from "../../src/db/deviceTeardownOperationRepository";

export class FakeDeviceTeardownOperationStore implements DeviceTeardownOperationStore {
  private readonly operations = new Map<
    string,
    { fingerprint: string; ownerToken: string; result?: unknown; expiresAtMs: number }
  >();

  async begin(
    operationId: string,
    requestFingerprint: string,
    ownerToken: string,
    nowMs: number,
    expiresAtMs: number,
  ): Promise<DeviceTeardownOperationBeginResult> {
    const existing = this.operations.get(operationId);
    if (existing && existing.expiresAtMs > nowMs) {
      if (existing.fingerprint !== requestFingerprint) {
        return { status: "conflict" };
      }
      return existing.result === undefined
        ? { status: "in_progress" }
        : { status: "completed", result: existing.result };
    }
    this.operations.set(operationId, {
      fingerprint: requestFingerprint,
      ownerToken,
      expiresAtMs,
    });
    return { status: "started" };
  }

  async renew(
    operationId: string,
    requestFingerprint: string,
    ownerToken: string,
    expiresAtMs: number,
  ): Promise<void> {
    const operation = this.operations.get(operationId);
    if (
      operation?.fingerprint === requestFingerprint &&
      operation.ownerToken === ownerToken &&
      operation.result === undefined
    ) {
      operation.expiresAtMs = expiresAtMs;
    }
  }

  async complete(
    operationId: string,
    requestFingerprint: string,
    ownerToken: string,
    result: unknown,
    expiresAtMs: number,
  ): Promise<void> {
    const operation = this.operations.get(operationId);
    if (operation?.fingerprint === requestFingerprint && operation.ownerToken === ownerToken) {
      operation.result = result;
      operation.expiresAtMs = expiresAtMs;
    }
  }

  async delete(operationId: string, requestFingerprint: string, ownerToken: string): Promise<void> {
    const operation = this.operations.get(operationId);
    if (operation?.fingerprint === requestFingerprint && operation.ownerToken === ownerToken) {
      this.operations.delete(operationId);
    }
  }
}
