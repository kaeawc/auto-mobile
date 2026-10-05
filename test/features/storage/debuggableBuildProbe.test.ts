import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  parseDebuggableBuild,
  probeDebuggableBuild,
} from "../../../src/features/storage/debuggableBuildProbe";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { logger } from "../../../src/utils/logger";

const fixture = (name: string) =>
  readFileSync(
    new URL(`../../fixtures/android-dumpsys-package/${name}.txt`, import.meta.url),
    "utf8",
  );
const debuggable = fixture("dumpsys-package-installed");
const system = fixture("dumpsys-package-system-installed");

test("captured pkgFlags distinguishes debuggable and system apps", () => {
  expect(parseDebuggableBuild(debuggable)).toBe(true);
  expect(parseDebuggableBuild(system)).toBe(false);
});
test("missing package, empty output and permission flags remain unknown", () => {
  expect(parseDebuggableBuild(fixture("dumpsys-package-not-installed"))).toBeUndefined();
  expect(parseDebuggableBuild("")).toBeUndefined();
  expect(parseDebuggableBuild("    flags=[ DEBUGGABLE ]")).toBeUndefined();
});
test.each([
  ["debuggable", debuggable, true],
  ["system", system, false],
] as const)(
  "probe reads captured %s output with quoted app scope",
  async (_name, stdout, expected) => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("dumpsys package", {
      stdout,
      stderr: "",
      toString: () => stdout,
      trim: () => stdout.trim(),
      includes: (value) => stdout.includes(value),
    });
    expect(await probeDebuggableBuild(adb, "com.example.app")).toBe(expected);
    expect(adb.getExecutedCommands()).toEqual(["shell dumpsys package 'com.example.app'"]);
    expect(adb.getCommandCalls()[0].timeoutMs).toBe(5000);
  },
);
test("probe logs adb failure and returns unknown without throwing", async () => {
  const adb = new FakeAdbExecutor();
  const failure = new Error("adb timeout");
  adb.setCommandError("dumpsys package", failure);
  const warning = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    expect(await probeDebuggableBuild(adb, "com.example.app")).toBeUndefined();
    expect(warning).toHaveBeenCalledWith(expect.any(String), failure);
  } finally {
    warning.mockRestore();
  }
});
test("app scope is one literal shell argument even with metacharacters", async () => {
  const adb = new FakeAdbExecutor();
  expect(await probeDebuggableBuild(adb, "com.example.app'; echo injected")).toBeUndefined();
  expect(adb.getExecutedCommands()).toEqual([
    "shell dumpsys package 'com.example.app'\\''; echo injected'",
  ]);
});
