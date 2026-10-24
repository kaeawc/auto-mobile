import { SimulatorTemplatesHarness } from "../helpers/SimulatorTemplatesHarness";
import { expect, test } from "bun:test";
import {
  parseIosTemplatesArgs,
  runIosTemplatesCommand,
  resolveTemplateMaintenanceKey,
} from "../../src/cli/iosTemplates";
const key = {
  runtime: "ios",
  runtimeBuild: "R1",
  xcodeBuild: "X1",
  deviceType: "phone",
  profile: "none" as const,
};
test("maintenance parser requires an explicit clean target", () => {
  expect(parseIosTemplatesArgs(["clean", "--all", "--force"])).toEqual({
    action: "clean",
    all: true,
    force: true,
    runtime: undefined,
    deviceType: undefined,
  });
  expect(() => parseIosTemplatesArgs(["clean"])).toThrow("Usage");
  expect(() => parseIosTemplatesArgs(["build", "--all"])).toThrow("Usage");
  expect(() => parseIosTemplatesArgs(["clean", "--all", "--typo"])).toThrow("Usage");
});
test("build and clean dispatch only explicit maintenance actions", async () => {
  const calls: string[] = [];
  const deps = {
    platform: "darwin" as const,
    write: (line: string) => {
      calls.push(line);
    },
    resolveKey: async () => key,
    build: async () => {
      calls.push("build");
      return "ready" as const;
    },
    clean: async () => {
      calls.push("clean");
    },
  };
  expect(
    await runIosTemplatesCommand(["build", "--runtime", "ios", "--device-type", "phone"], deps),
  ).toBe(0);
  expect(await runIosTemplatesCommand(["clean", "--all"], deps)).toBe(0);
  expect(calls).toContain("build");
  expect(calls).toContain("clean");
});
test("help prints usage successfully without resolving maintenance dependencies", async () => {
  const lines: string[] = [];
  const deps = {
    platform: "linux" as const,
    write: (line: string) => {
      lines.push(line);
    },
    resolveKey: async () => {
      throw new Error("unexpected key");
    },
    build: async () => {
      throw new Error("unexpected build");
    },
    clean: async () => {
      throw new Error("unexpected clean");
    },
  };
  expect(await runIosTemplatesCommand(["--help"], deps)).toBe(0);
  expect(lines[0]).toContain("Usage:");
  expect(parseIosTemplatesArgs(["clean", "--stale"]).stale).toBe(true);
  expect(parseIosTemplatesArgs(["clean", "--runtime", "ios"]).runtime).toBe("ios");
});
test("SIGINT aborts an explicit build and permits cleanup before returning", async () => {
  let cleaned = false;
  const deps = {
    platform: "darwin" as const,
    write: () => {},
    resolveKey: async () => key,
    clean: async () => {},
    build: async (_key: typeof key, signal?: AbortSignal) => {
      process.emit("SIGINT");
      expect(signal?.aborted).toBe(true);
      cleaned = true;
      return "failed";
    },
  };
  expect(
    await runIosTemplatesCommand(["build", "--runtime", "ios", "--device-type", "phone"], deps),
  ).toBe(1);
  expect(cleaned).toBe(true);
});
test("unknown maintenance device type fails before writing any manifest", async () => {
  const fake = new SimulatorTemplatesHarness();
  const deps = {
    client: fake.client,
    store: fake.store,
    timer: fake.timer,
    profile: () => "none" as const,
    xcode: { readBuild: async () => "X1" },
    lock: { acquire: async () => undefined, acquireName: async () => undefined },
    builder: {
      build: async () => {
        throw new Error("unexpected build");
      },
    },
  };
  await expect(resolveTemplateMaintenanceKey(deps, "ios", "unknown")).rejects.toThrow(
    "Unknown simulator device type",
  );
  expect(fake.manifest).toBeUndefined();
});
