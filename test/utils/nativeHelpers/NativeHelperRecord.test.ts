import { expect, test } from "bun:test";
import {
  FileNativeHelperRecordStore,
  isNativeHelperRecord,
  type NativeHelperRecord,
} from "../../../src/utils/nativeHelpers/NativeHelperRecordStore";
import { FakeLogger } from "../../fakes/FakeLogger";

const valid: NativeHelperRecord = {
  version: 1,
  kind: "iproxy",
  pid: 20,
  startIdentity: "start",
  processGroup: false,
  ownerPid: 10,
  ownerStartIdentity: "owner",
  recordedAtMs: 1,
};

test("validates versioned JSON fields without coercion", () => {
  expect(isNativeHelperRecord(JSON.parse(JSON.stringify(valid)))).toBe(true);
});
const malformed = [
  null,
  [],
  {},
  { ...valid, version: 2 },
  { ...valid, kind: "other" },
  { ...valid, pid: 0 },
  { ...valid, pid: 1 },
  { ...valid, pid: "20" },
  { ...valid, pid: 1.1 },
  { ...valid, ownerPid: -1 },
  { ...valid, startIdentity: "" },
  { ...valid, ownerStartIdentity: null },
  { ...valid, processGroup: "false" },
  { ...valid, recordedAtMs: Infinity },
];
test.each(malformed.map((value) => [value]))("rejects malformed records %#", (value) => {
  expect(isNativeHelperRecord(value)).toBe(false);
});
test("constructing a file store resolves no directory", () => {
  // Construction is safe even before the caller establishes its AUTOMOBILE_DATA_DIR.
  expect(new FileNativeHelperRecordStore(new FakeLogger())).toBeInstanceOf(
    FileNativeHelperRecordStore,
  );
});
