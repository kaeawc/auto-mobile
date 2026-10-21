import type {
  NativeHelperRecord,
  NativeHelperRecordStore,
} from "../../src/utils/nativeHelpers/NativeHelperRecordStore";

import { compareCodeUnits } from "../../src/utils/io";

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
    // The file store lists `<pid>.json` names in code-unit order, so "1000" sorts before "95".
    return [...this.records.values()]
      .sort((a, b) => compareCodeUnits(`${a.pid}.json`, `${b.pid}.json`))
      .map((record) => ({ ...record }));
  }
}
