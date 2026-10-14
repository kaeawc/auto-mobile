import type {
  NativeHelperRecord,
  NativeHelperRecordStore,
} from "../../src/utils/nativeHelpers/NativeHelperRecordStore";

export class FakeNativeHelperRecordStore implements NativeHelperRecordStore {
  readonly records = new Map<number, NativeHelperRecord>();
  write(record: NativeHelperRecord): void {
    this.records.set(record.pid, { ...record });
  }
  remove(pid: number, expectedStartIdentity?: string): void {
    if (
      expectedStartIdentity === undefined ||
      this.records.get(pid)?.startIdentity === expectedStartIdentity
    ) {
      this.records.delete(pid);
    }
  }
  list(): NativeHelperRecord[] {
    return [...this.records.values()];
  }
}
