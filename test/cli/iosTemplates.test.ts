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
    onInterrupt: () => {},
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
    onInterrupt: () => {},
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
test("SIGINT aborts an explicit build, finishes its cleanup, and exits 130 (#15312)", async () => {
  const lines: string[] = [];
  const order: string[] = [];
  let interrupt: (() => Promise<void>) | undefined;
  let building: (() => void) | undefined;
  const deps = {
    platform: "darwin" as const,
    onInterrupt: (listener: () => Promise<void>) => {
      interrupt = listener;
    },
    write: (line: string) => {
      lines.push(line);
    },
    resolveKey: async () => key,
    clean: async () => {},
    build: async (_key: typeof key, signal?: AbortSignal) => {
      await new Promise<void>((resolve) => {
        building = resolve;
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      expect(signal?.aborted).toBe(true);
      // Stands in for removing the partial simulator and releasing the lock.
      await Promise.resolve();
      order.push("cleaned");
      return "failed";
    },
  };
  const command = runIosTemplatesCommand(
    ["build", "--runtime", "ios", "--device-type", "phone"],
    deps,
  );
  while (!building) {
    await Promise.resolve();
  }

  await interrupt!();
  order.push("interrupt listener returned");

  expect(order).toEqual(["cleaned", "interrupt listener returned"]);
  expect(await command).toBe(130);
  expect(lines).toEqual([JSON.stringify({ result: "interrupted" })]);
});
test("a build that finishes without an interrupt keeps its ordinary exit code", async () => {
  const deps = {
    platform: "darwin" as const,
    onInterrupt: () => {},
    write: () => {},
    resolveKey: async () => key,
    clean: async () => {},
    build: async () => "failed",
  };
  expect(
    await runIosTemplatesCommand(["build", "--runtime", "ios", "--device-type", "phone"], deps),
  ).toBe(1);
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
