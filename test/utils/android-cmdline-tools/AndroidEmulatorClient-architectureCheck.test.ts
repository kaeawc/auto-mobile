import { describe, expect, test } from "bun:test";
import {
  AndroidEmulatorClient,
  normalizeAbiToArch,
} from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { ExecResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { AdbExecutor } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AvdConfig } from "../../../src/utils/android-cmdline-tools/AvdConfigReader";
import { FakeAvdConfigReader } from "../../fakes/FakeAvdConfigReader";
import { ChildProcess } from "child_process";

const createExecResult = (stdout: string, stderr = ""): ExecResult => ({
  stdout,
  stderr,
  toString() {
    return this.stdout;
  },
  trim() {
    return this.stdout.trim();
  },
  includes(searchString: string) {
    return this.stdout.includes(searchString);
  },
});

class TestAdbClientFactory implements AdbClientFactory {
  constructor(private readonly fakeExecutor: FakeAdbExecutor) {}
  create(): AdbExecutor {
    return this.fakeExecutor;
  }
}

/**
 * Build a client whose emulator CLI seam records every argv it is handed, so a
 * test can assert the architecture check never boots an `emulator -verbose`
 * probe (the stale-lock root cause of issue #5202).
 */
function makeClient(config: AvdConfig | null, hostArch?: string) {
  const execCalls: string[][] = [];
  const spawns: string[][] = [];
  const execAsync = async (_file: string, args: string[]): Promise<ExecResult> => {
    execCalls.push(args);
    return createExecResult("");
  };
  const spawnFn = ((_cmd: string, args: string[]) => {
    spawns.push(args);
    return {} as ChildProcess;
  }) as unknown as (command: string, args: string[]) => ChildProcess;

  const client = new AndroidEmulatorClient(
    execAsync,
    spawnFn,
    new FakeTimer(),
    new TestAdbClientFactory(new FakeAdbExecutor()),
    new FakeAvdConfigReader(config),
  );
  (client as any).ensureEmulatorPath = async () => "emulator";
  if (hostArch) {
    (client as any).getHostArchitecture = () => hostArch;
  }
  return { client, execCalls, spawns };
}

function checkArch(client: AndroidEmulatorClient, avdName: string) {
  return (
    client as unknown as {
      checkArchitectureCompatibility: (name: string) => Promise<{
        compatible: boolean;
        hostArch: string;
        avdArch?: string;
        reason?: string;
      }>;
    }
  ).checkArchitectureCompatibility(avdName);
}

describe("normalizeAbiToArch", () => {
  test("maps recognized ABIs to coarse arch tokens", () => {
    expect(normalizeAbiToArch("arm64-v8a")).toBe("arm64");
    expect(normalizeAbiToArch("armeabi-v7a")).toBe("arm");
    expect(normalizeAbiToArch("armeabi")).toBe("arm");
    expect(normalizeAbiToArch("x86_64")).toBe("x86_64");
    expect(normalizeAbiToArch("x86")).toBe("x86");
    expect(normalizeAbiToArch("riscv64")).toBe("riscv64");
    expect(normalizeAbiToArch("X86_64")).toBe("x86_64");
  });

  test("returns undefined for missing or unrecognized ABIs", () => {
    expect(normalizeAbiToArch(undefined)).toBeUndefined();
    expect(normalizeAbiToArch("")).toBeUndefined();
    expect(normalizeAbiToArch("mips")).toBeUndefined();
  });
});

describe("checkArchitectureCompatibility (issue #5202)", () => {
  test("derives the ABI from config.ini without booting an emulator probe", async () => {
    const { client, execCalls, spawns } = makeClient({ abi: "arm64-v8a" }, "arm64");
    const result = await checkArch(client, "Pixel_9_Pro_Fold");

    expect(result.compatible).toBe(true);
    expect(result.avdArch).toBe("arm64");
    // The old implementation ran `emulator -avd <name> -verbose`, which left a
    // stale QEMU lock. The fix must not spawn or exec any emulator process.
    expect(spawns).toEqual([]);
    expect(execCalls.some((args) => args.includes("-verbose"))).toBe(false);
    expect(execCalls).toEqual([]);
  });

  test("flags an x86_64 guest as incompatible on an arm64 host", async () => {
    const { client } = makeClient({ abi: "x86_64" }, "arm64");
    const result = await checkArch(client, "Legacy_x86");

    expect(result.compatible).toBe(false);
    expect(result.avdArch).toBe("x86_64");
    expect(result.reason).toContain("arm64");
  });

  test("allows an x86_64 guest on an x86_64 host", async () => {
    const { client } = makeClient({ abi: "x86_64" }, "x86_64");
    const result = await checkArch(client, "Ci_x86");

    expect(result.compatible).toBe(true);
    expect(result.avdArch).toBe("x86_64");
  });

  test("allows the attempt when config is missing or has no ABI", async () => {
    const missing = makeClient(null, "arm64");
    const noAbi = makeClient({ apiLevel: 34 }, "arm64");

    const r1 = await checkArch(missing.client, "Unknown");
    const r2 = await checkArch(noAbi.client, "NoAbi");

    expect(r1.compatible).toBe(true);
    expect(r1.reason).toContain("Could not determine");
    expect(r2.compatible).toBe(true);
    // Still no throwaway probe on the fallback path.
    expect(missing.execCalls).toEqual([]);
    expect(noAbi.spawns).toEqual([]);
  });
});
