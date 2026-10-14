import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  FileNativeHelperRecordStore,
  isNativeHelperRecord,
  type NativeHelperRecord,
} from "../../../src/utils/nativeHelpers/NativeHelperRecordStore";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTempDir } from "../../../src/utils/tempDir";
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

let directory: string;
let root: string;
const originalDataDir = process.env.AUTOMOBILE_DATA_DIR;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "native-helper-records-"));
  process.env.AUTOMOBILE_DATA_DIR = root;
  directory = getTempDir("native-helpers");
  mkdirSync(directory);
});
afterAll(() => {
  if (originalDataDir === undefined) {
    delete process.env.AUTOMOBILE_DATA_DIR;
  } else {
    process.env.AUTOMOBILE_DATA_DIR = originalDataDir;
  }
  rmSync(root, { recursive: true, force: true });
});

function clearRecords(): void {
  for (const file of readdirSync(directory)) {
    rmSync(join(directory, file), { recursive: true, force: true });
  }
}

test.each(["start", "replacement", undefined])(
  "conditional removal checks stored generation %s",
  (expected) => {
    clearRecords();
    const store = new FileNativeHelperRecordStore(new FakeLogger());
    store.write(valid);
    store.remove(20, expected);
    expect(existsSync(join(directory, "20.json"))).toBe(expected === "replacement");
  },
);
test.each(["{", "{}"])("conditional removal retains unreadable record %s", (content) => {
  clearRecords();
  const store = new FileNativeHelperRecordStore(new FakeLogger());
  writeFileSync(join(directory, "20.json"), content);
  expect(() => store.remove(20, "start")).not.toThrow();
  expect(existsSync(join(directory, "20.json"))).toBe(true);
  store.remove(20);
  expect(existsSync(join(directory, "20.json"))).toBe(false);
});

test.each([
  ["20.json", "{"],
  ["20.json", "{}"],
  ["21.json", JSON.stringify(valid)],
])("quarantines corrupt record %s with content %s once", (file, content) => {
  clearRecords();
  const logger = new FakeLogger();
  const store = new FileNativeHelperRecordStore(logger);
  writeFileSync(join(directory, file), content);
  expect(store.list()).toEqual([]);
  expect(store.corruptRecordsSkipped).toBe(1);
  expect(existsSync(join(directory, `${file}.corrupt`))).toBe(true);
  expect(logger.at("warn")).toHaveLength(1);
  expect(JSON.stringify(logger.at("warn"))).toContain(`${file}.corrupt`);
  expect(store.list()).toEqual([]);
  expect(store.corruptRecordsSkipped).toBe(0);
  expect(logger.at("warn")).toHaveLength(1);
});

test.each([
  ["20.json.40.1.tmp", false],
  ["20.json.40.1.tmp", true],
  ["malformed.tmp", false],
] as const)("quarantines tmp %s only when writer is not live (%s)", (file, live) => {
  clearRecords();
  const logger = new FakeLogger();
  const probes: number[] = [];
  const store = new FileNativeHelperRecordStore(logger, (pid) => {
    probes.push(pid);
    return live;
  });
  writeFileSync(join(directory, file), "partial");
  expect(store.list()).toEqual([]);
  expect(probes).toEqual(file === "malformed.tmp" ? [] : [40]);
  expect(existsSync(join(directory, file))).toBe(live);
  expect(existsSync(join(directory, `${file}.corrupt`))).toBe(!live);
  expect(store.corruptRecordsSkipped).toBe(live ? 0 : 1);
  expect(logger.at("warn")).toHaveLength(live ? 0 : 1);
});

test("quarantine rename failure warns without throwing", () => {
  clearRecords();
  const logger = new FakeLogger();
  const store = new FileNativeHelperRecordStore(logger);
  writeFileSync(join(directory, "20.json"), "{");
  mkdirSync(join(directory, "20.json.corrupt"));
  writeFileSync(join(directory, "20.json.corrupt", "blocker"), "occupied");
  expect(() => store.list()).not.toThrow();
  expect(store.corruptRecordsSkipped).toBe(1);
  expect(existsSync(join(directory, "20.json"))).toBe(true);
  expect(logger.at("warn")).toHaveLength(1);
});
