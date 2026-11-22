import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ActionableError } from "../../../src/models/ActionableError";
import type { ExecFileAsync } from "../../../src/utils/HostCommandExecutor";
import {
  SwiftcHealthKitAppBuilder,
  type HealthKitBuildFs,
} from "../../../src/utils/ios/healthKitSeederApp";
import { useScratchRoot } from "../../helpers/scratchRoot";

/** Real directories so the build can write its sources; records what is removed. */
class RecordingFs implements HealthKitBuildFs {
  created: string[] = [];
  removed: string[] = [];
  constructor(private readonly scratch: { next(): string }) {}
  async mkdtemp(): Promise<string> {
    const dir = this.scratch.next();
    this.created.push(dir);
    return dir;
  }
  async rm(path: string): Promise<void> {
    this.removed.push(path);
    await rm(path, { recursive: true, force: true });
  }
}

function fakeExec(failOn?: string): ExecFileAsync {
  return async (file) => {
    if (file === failOn) {
      throw new Error(`${file} failed`);
    }
    return { stdout: "/sdk\n", stderr: "" };
  };
}

describe("SwiftcHealthKitAppBuilder", () => {
  const scratch = useScratchRoot("am-hkseeder-test-");

  test("disposing a default build removes the temp root it created", async () => {
    const fs = new RecordingFs(scratch);
    const build = await new SwiftcHealthKitAppBuilder(fakeExec(), undefined, fs).build();
    expect(build.appPath).toBe(join(fs.created[0], "hkseeder.app"));
    expect(existsSync(fs.created[0])).toBe(true);
    await build.dispose();
    expect(fs.removed).toEqual(fs.created);
    expect(existsSync(fs.created[0])).toBe(false);
  });

  test("a failed default build removes its temp root and throws an actionable error", async () => {
    const fs = new RecordingFs(scratch);
    const error = await new SwiftcHealthKitAppBuilder(fakeExec("swiftc"), undefined, fs)
      .build()
      .catch((e) => e);
    expect(error).toBeInstanceOf(ActionableError);
    expect(error.message).toContain("Failed to build the HealthKit seeding app");
    expect(fs.created).toHaveLength(1);
    expect(fs.removed).toEqual(fs.created);
    expect(existsSync(fs.created[0])).toBe(false);
  });

  test("never removes an injected work directory", async () => {
    const workDir = scratch.next();
    const fs = new RecordingFs(scratch);
    const build = await new SwiftcHealthKitAppBuilder(fakeExec(), workDir, fs).build();
    await build.dispose();
    await new SwiftcHealthKitAppBuilder(fakeExec("codesign"), workDir, fs).build().catch(() => {});
    expect(fs.created).toEqual([]);
    expect(fs.removed).toEqual([]);
    expect(existsSync(workDir)).toBe(true);
  });
});
