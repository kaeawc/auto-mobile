import { describe, expect, test } from "bun:test";
import {
  SimCtlClient,
  type SimCtlFileSystem,
} from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { BootedDevice } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";

// In-memory fake for SimCtlFileSystem so these tests never touch the real
// host tmp dir (repo fake-injection rule). Tracks calls so a test could
// assert on them if needed; storage is a plain Map keyed by path.
function createFakeSimCtlFileSystem(): SimCtlFileSystem & { writes: Map<string, string> } {
  const writes = new Map<string, string>();
  let mkdtempCount = 0;
  return {
    writes,
    mkdtemp: async (prefix: string) => `${prefix}fake-${++mkdtempCount}`,
    writeFile: async (path: string, data: string) => {
      writes.set(path, data);
    },
    readFile: async (path: string) => {
      const data = writes.get(path);
      if (data === undefined) {
        throw new Error(`fake fs: no file written at ${path}`);
      }
      return data;
    },
    rm: async (path: string) => {
      // Recursive delete semantics: drop this exact path plus anything nested
      // under it, mirroring `fs.promises.rm({ recursive: true })` removing a
      // whole temp directory. The real pushNotification joins the child path
      // with `path.join`, which uses "\" on Windows and "/" elsewhere, so
      // both separators must be accepted here or a Windows-hosted temp file
      // silently survives cleanup (issue #6517 windows-latest CI failure).
      for (const key of writes.keys()) {
        if (key === path || key.startsWith(`${path}/`) || key.startsWith(`${path}\\`)) {
          writes.delete(key);
        }
      }
    },
  };
}

describe("SimCtlClient pushNotification", () => {
  const device: BootedDevice = {
    deviceId: "ios-device-push",
    name: "iOS Device",
    platform: "ios",
    source: "local",
  };

  // Issue #6517: `simctl push` can exit 0 (delivered) while still writing
  // advisory/diagnostic text to stderr. Success must be driven by the exit
  // code (via executeCommandArgs throwing on non-zero exit), not by stderr
  // content.
  test("returns success when simctl push exits 0 with non-empty stderr", async () => {
    const execAsync = async (_file: string, args: string[]) => {
      if (args.join(" ") === "simctl --version") {
        return createExecResult("simctl version 1.0.0", "");
      }
      if (args[0] === "simctl" && args[1] === "push") {
        return createExecResult("", "warning: some advisory diagnostic text");
      }
      return createExecResult("", "");
    };

    const fileSystem = createFakeSimCtlFileSystem();
    const simctl = new SimCtlClient(device, execAsync, undefined, undefined, undefined, fileSystem);
    const result = await simctl.pushNotification(
      "ios-device-push",
      "com.example.app",
      JSON.stringify({ aps: { alert: "hi" } }),
    );

    expect(result).toEqual({ success: true });
    // Confirms the write went through the fake, not the real host tmp dir.
    expect(fileSystem.writes.size).toBe(0);
  });

  // The real implementation joins `dir` + "payload.apns" with `path.join`,
  // which uses "\" on Windows (issue #6517 windows-latest CI failure: the
  // fake's `rm` only matched a "/"-joined child path, so the temp-file entry
  // survived cleanup and `writes.size` was 1, not 0). Exercise the fake
  // directly with a manually backslash-joined path so this is reproducible on
  // any host, not just an actual Windows runner.
  test("fake filesystem rm() recursively clears children joined with either path separator", async () => {
    const fileSystem = createFakeSimCtlFileSystem();
    await fileSystem.writeFile(
      "C:\\Users\\ci\\AppData\\Local\\Temp\\automobile-apns-fake-1\\payload.apns",
      "{}",
      "utf8",
    );

    await fileSystem.rm("C:\\Users\\ci\\AppData\\Local\\Temp\\automobile-apns-fake-1", {
      recursive: true,
      force: true,
    });

    expect(fileSystem.writes.size).toBe(0);
  });

  test("returns failure when simctl push exits non-zero", async () => {
    const execAsync = async (_file: string, args: string[]) => {
      if (args.join(" ") === "simctl --version") {
        return createExecResult("simctl version 1.0.0", "");
      }
      if (args[0] === "simctl" && args[1] === "push") {
        throw new Error("Invalid device state");
      }
      return createExecResult("", "");
    };

    const fileSystem = createFakeSimCtlFileSystem();
    const simctl = new SimCtlClient(device, execAsync, undefined, undefined, undefined, fileSystem);
    const result = await simctl.pushNotification(
      "ios-device-push",
      "com.example.app",
      JSON.stringify({ aps: { alert: "hi" } }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid device state");
    // Confirms the write went through the fake, not the real host tmp dir.
    expect(fileSystem.writes.size).toBe(0);
  });
});
