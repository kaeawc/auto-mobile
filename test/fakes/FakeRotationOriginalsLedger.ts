import type { RotationRestoreState } from "../../src/features/action/RotationSupport";
import {
  sameRotationOriginals,
  type RotationOriginalsLedger,
} from "../../src/daemon/rotationOriginalsLedger";

/** In-memory ledger; survives a SessionManager "restart" when the same instance is reused. */
export class FakeRotationOriginalsLedger implements RotationOriginalsLedger {
  readonly records = new Map<string, RotationRestoreState>();
  readonly calls: string[] = [];
  failNext: "loadAll" | "save" | "clear" | "remove" | undefined;

  async loadAll(): Promise<ReadonlyMap<string, RotationRestoreState>> {
    this.calls.push("loadAll");
    this.maybeFail("loadAll");
    return new Map(this.records);
  }

  async save(deviceId: string, state: RotationRestoreState): Promise<boolean> {
    this.calls.push(`save ${deviceId}`);
    this.maybeFail("save");
    if (this.records.has(deviceId)) {
      return false;
    }
    this.records.set(deviceId, { ...state });
    return true;
  }

  async clear(deviceId: string, state: RotationRestoreState): Promise<void> {
    this.calls.push(`clear ${deviceId}`);
    this.maybeFail("clear");
    const stored = this.records.get(deviceId);
    if (stored && sameRotationOriginals(stored, state)) {
      this.records.delete(deviceId);
    }
  }

  async remove(deviceId: string): Promise<void> {
    this.calls.push(`remove ${deviceId}`);
    this.maybeFail("remove");
    this.records.delete(deviceId);
  }

  private maybeFail(operation: "loadAll" | "save" | "clear" | "remove"): void {
    if (this.failNext === operation) {
      this.failNext = undefined;
      throw new Error(`${operation} refused`);
    }
  }
}
