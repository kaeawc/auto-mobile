import { readGuardFile } from "./astGuard";
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHostSpawnAllowList } from "../setup/realDeviceToolSpawnGuard";

const root = fileURLToPath(new URL("../../", import.meta.url));
const text = readGuardFile(resolve(root, "scripts/unit-test-host-spawn-allowlist.txt"));
const lines = text.split(/\r?\n/);
const entryLines = lines.filter((line) => line && !line.startsWith("#"));
const { allowList, errors } = parseHostSpawnAllowList(text);

test("every host-spawn allow-list line is a unit test file and a command that may be listed", () => {
  // A listed adb, xcrun, simctl, emulator, avdmanager or defaults is an error here, and the guard
  // drops the line, so it permits nothing.
  expect(errors).toEqual([]);
  expect(entryLines.every((line) => /^\S+ \S+$/.test(line))).toBe(true);
});

test("host-spawn allow-list entries are sorted, unique and name existing test files", () => {
  expect(entryLines).toEqual(
    [...new Set(entryLines)].sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    ),
  );
  for (const testFile of allowList.keys()) {
    expect(existsSync(resolve(root, testFile)), testFile).toBe(true);
  }
});

test("every host-spawn allow-list entry sits directly under a comment saying why it is harmless", () => {
  const uncommented = lines.filter(
    (line, index) => line && !line.startsWith("#") && !lines[index - 1]?.startsWith("# "),
  );
  expect(uncommented).toEqual([]);
});
