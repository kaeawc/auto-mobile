import { describe, expect, test } from "bun:test";
import type {
  NativeHelperRecord,
  NativeHelperRecordStore,
} from "../../src/utils/nativeHelpers/NativeHelperRecordStore";

export interface NativeHelperRecordStoreHandle {
  store: NativeHelperRecordStore;
  dispose?: () => Promise<void> | void;
}

function record(pid: number, overrides: Partial<NativeHelperRecord> = {}): NativeHelperRecord {
  return {
    version: 1,
    kind: "iproxy",
    pid,
    startIdentity: `start-${pid}`,
    processGroup: false,
    ownerPid: 4242,
    ownerStartIdentity: "owner-start",
    recordedAtMs: 1_700_000_000_000 + pid,
    ...overrides,
  };
}

/**
 * Shared behavioural contract for {@link NativeHelperRecordStore} (#11868): the in-memory fake
 * and the file-backed store run the same write/list/remove scenarios. Corrupt-file quarantine is
 * a real-store-only concern covered by the sweep integration test.
 */
export function runNativeHelperRecordStoreContract(
  name: string,
  make: () => Promise<NativeHelperRecordStoreHandle>,
): void {
  const withStore = async (body: (store: NativeHelperRecordStore) => void): Promise<void> => {
    const handle = await make();
    try {
      body(handle.store);
    } finally {
      await handle.dispose?.();
    }
  };

  describe(`NativeHelperRecordStore contract: ${name}`, () => {
    test("an empty store lists nothing", () =>
      withStore((store) => {
        expect(store.list()).toEqual([]);
      }));

    test("a written record round-trips every field", () =>
      withStore((store) => {
        const written = record(900, { kind: "ios-capture-helper", processGroup: true });
        store.write(written);
        expect(store.list()).toEqual([written]);
      }));

    test("writing the same pid replaces the earlier record", () =>
      withStore((store) => {
        store.write(record(900));
        store.write(record(900, { startIdentity: "reused-pid", kind: "adb" }));
        expect(store.list()).toEqual([record(900, { startIdentity: "reused-pid", kind: "adb" })]);
      }));

    test("a stored record does not alias the caller's object", () =>
      withStore((store) => {
        const written = record(900);
        store.write(written);
        written.startIdentity = "mutated";
        expect(store.list()[0]?.startIdentity).toBe("start-900");
      }));

    test("list is ordered by the record file name, not insertion order", () =>
      withStore((store) => {
        // File names sort as code units: "1000.json" < "901.json" < "95.json".
        store.write(record(95));
        store.write(record(1000));
        store.write(record(901));
        expect(store.list().map((entry) => entry.pid)).toEqual([1000, 901, 95]);
      }));

    test("remove without an identity deletes the record", () =>
      withStore((store) => {
        store.write(record(900));
        store.write(record(901));
        store.remove(900);
        expect(store.list().map((entry) => entry.pid)).toEqual([901]);
      }));

    test("remove with a matching identity deletes the record", () =>
      withStore((store) => {
        store.write(record(900));
        store.remove(900, "start-900");
        expect(store.list()).toEqual([]);
      }));

    test("remove with a stale identity keeps a reused pid's record", () =>
      withStore((store) => {
        store.write(record(900, { startIdentity: "new-process" }));
        store.remove(900, "old-process");
        expect(store.list().map((entry) => entry.startIdentity)).toEqual(["new-process"]);
      }));

    test("removing an absent pid is a no-op with or without an identity", () =>
      withStore((store) => {
        store.write(record(901));
        store.remove(900);
        store.remove(900, "start-900");
        expect(store.list().map((entry) => entry.pid)).toEqual([901]);
      }));
  });
}
