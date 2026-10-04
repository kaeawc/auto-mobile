import { describe, expect, mock, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ActionableError } from "../../../src/models";
import { AvdManagerClient } from "../../../src/utils/android-cmdline-tools/AvdManagerClient";
import { FakeTimer } from "../../fakes/FakeTimer";

const listDeviceOutput = readFileSync(
  join(import.meta.dir, "../../fixtures/android-avdmanager/list-device.txt"),
  "utf8",
);

const normalizePath = (value: string): string => value.replace(/\\/g, "/");

class FakeChild {
  readonly stdout = {
    on: (_event: string, callback: (data: Buffer) => void) => {
      this.stdoutCallback = callback;
    },
  };
  readonly stderr = {
    on: (_event: string, callback: (data: Buffer) => void) => {
      this.stderrCallback = callback;
    },
  };
  readonly stdin = {
    write: (value: string) => {
      this.stdinWrites.push(value);
    },
    end: () => {
      this.stdinEnded = true;
    },
  };
  readonly kills: NodeJS.Signals[] = [];
  readonly stdinWrites: string[] = [];
  stdinEnded = false;
  private stdoutCallback?: (data: Buffer) => void;
  private stderrCallback?: (data: Buffer) => void;
  private closeCallback?: (code: number | null) => void;
  private exitCallback?: (code: number | null) => void;
  private errorCallback?: (error: Error) => void;

  on(event: string, callback: (value: never) => void): this {
    if (event === "close") {
      this.closeCallback = callback as (code: number | null) => void;
    }
    if (event === "exit") {
      this.exitCallback = callback as (code: number | null) => void;
    }
    if (event === "error") {
      this.errorCallback = callback as (error: Error) => void;
    }
    return this;
  }

  kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal);
    return true;
  }

  close(code: number | null): void {
    this.closeCallback?.(code);
  }
  exit(code: number | null): void {
    this.exitCallback?.(code);
  }
  stdoutText(value: string): void {
    this.stdoutCallback?.(Buffer.from(value));
  }
  stderrText(value: string): void {
    this.stderrCallback?.(Buffer.from(value));
  }
  fail(error: Error): void {
    this.errorCallback?.(error);
  }
}

function createClient(overrides: Partial<ConstructorParameters<typeof AvdManagerClient>[0]> = {}) {
  const child = new FakeChild();
  const timer = new FakeTimer();
  const calls: Array<{
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
    shell?: string | boolean;
  }> = [];
  const client = new AvdManagerClient({
    detectAndroidCommandLineTools: async () => [
      {
        path: "/sdk/cmdline-tools/latest",
        source: "manual",
        available_tools: ["avdmanager"],
      },
    ],
    getBestAndroidToolsLocation: (locations) => locations[0] ?? null,
    validateRequiredTools: () => ({ valid: true, missing: [] }),
    existsSync: (path) => path.endsWith("avdmanager") || path.endsWith("system-images"),
    spawn: (command, args, options) => {
      calls.push({ command, args, env: options.env, shell: options.shell });
      return child as unknown as ChildProcess;
    },
    logger: { info() {}, warn() {}, error() {} },
    timer,
    environment: { ANDROID_HOME: "/sdk" },
    platform: "linux",
    ...overrides,
  });
  return { client, child, timer, calls };
}

describe("AvdManagerClient", () => {
  for (const operation of ["listDeviceImages", "listDevices", "createAvd", "deleteAvd"] as const) {
    test(`${operation} honours a custom 1000ms timeout`, async () => {
      const { client, child, timer } = createClient();
      const options = { timeoutMs: 1_000 };
      const pending =
        operation === "createAvd"
          ? client.createAvd({ name: "pixel", package: "unused" }, options)
          : operation === "deleteAvd"
            ? client.deleteAvd("pixel", options)
            : client[operation](options);
      await new Promise<void>((resolve) => setImmediate(resolve));

      timer.advanceTime(999);
      expect(child.kills).toEqual([]);
      timer.advanceTime(1);
      child.close(0);

      if (operation === "createAvd" || operation === "deleteAvd") {
        await expect(pending).resolves.toEqual({
          success: false,
          message: `Failed to ${operation === "createAvd" ? "create" : "delete"} AVD pixel: avdmanager command timed out after 1000ms`,
        });
      } else {
        await expect(pending).rejects.toThrow("avdmanager command timed out after 1000ms");
      }
      expect(child.kills).toEqual(["SIGTERM"]);
      expect(timer.now()).toBe(1_000);
    });
  }

  for (const operation of ["createAvd", "deleteAvd"] as const) {
    test(`${operation} propagates mid-run cancellation without logging a failure`, async () => {
      const errorLog = mock(() => {});
      const { client, child } = createClient({
        logger: { info() {}, warn() {}, error: errorLog },
      });
      const controller = new AbortController();
      const options = { signal: controller.signal };
      const pending =
        operation === "createAvd"
          ? client.createAvd({ name: "pixel", package: "unused" }, options)
          : client.deleteAvd("pixel", options);
      await new Promise<void>((resolve) => setImmediate(resolve));

      controller.abort(new Error("provisioning request cancelled"));
      child.close(0);

      await expect(pending).rejects.toThrow("avdmanager command cancelled");
      await expect(pending).rejects.not.toBe(controller.signal.reason);
      expect(child.kills).toEqual(["SIGTERM"]);
      expect(errorLog).not.toHaveBeenCalled();
    });

    test(`${operation} preserves a timeout that precedes request cancellation`, async () => {
      const { client, child, timer } = createClient();
      const controller = new AbortController();
      const options = { timeoutMs: 1_000, signal: controller.signal };
      const pending =
        operation === "createAvd"
          ? client.createAvd({ name: "pixel", package: "unused" }, options)
          : client.deleteAvd("pixel", options);
      await new Promise<void>((resolve) => setImmediate(resolve));

      timer.advanceTime(1_000);
      controller.abort();
      child.close(0);

      await expect(pending).rejects.toThrow("avdmanager command timed out after 1000ms");
      expect(child.kills).toEqual(["SIGTERM"]);
    });

    test(`${operation} logs at warn level for a non-abort spawn failure and returns a typed failure`, async () => {
      const warnLog = mock((message: string, error?: unknown) => {});
      const errorLog = mock(() => {});
      const { client, child } = createClient({
        logger: { info() {}, warn: warnLog, error: errorLog },
      });
      const options = { signal: new AbortController().signal };
      const pending =
        operation === "createAvd"
          ? client.createAvd({ name: "pixel", package: "unused" }, options)
          : client.deleteAvd("pixel", options);
      await new Promise<void>((resolve) => setImmediate(resolve));
      child.fail(new Error("spawn unavailable"));

      const message = `Failed to ${operation === "createAvd" ? "create" : "delete"} AVD pixel: Failed to spawn avdmanager: spawn unavailable`;
      await expect(pending).resolves.toEqual({ success: false, message });
      expect(warnLog).toHaveBeenCalledTimes(1);
      expect(warnLog).toHaveBeenCalledWith(message, expect.any(Error));
      expect(warnLog.mock.calls[0][1]).toHaveProperty(
        "message",
        "Failed to spawn avdmanager: spawn unavailable",
      );
      expect(errorLog).not.toHaveBeenCalled();
      expect(child.kills).toEqual([]);
    });
  }

  test("missing cmdline-tools fails resolve before any avdmanager invocation", async () => {
    const { client, timer, calls } = createClient({
      detectAndroidCommandLineTools: async () => [],
    });
    await expect(client.listDeviceImages()).rejects.toThrow("Android command line tools not found");
    expect(timer.now()).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("missing avdmanager fails resolve before spawning", async () => {
    const { client, timer, calls } = createClient({
      validateRequiredTools: () => ({ valid: false, missing: ["avdmanager"] }),
    });
    await expect(client.listDeviceImages()).rejects.toThrow("Missing required tools: avdmanager");
    expect(timer.now()).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("returns failure stdout unchanged under the limit", async () => {
    const { client, child } = createClient();
    const pending = client.deleteAvd("pixel");
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.stdoutText("first ");
    child.stdoutText("second");
    child.close(1);
    expect(await pending).toEqual({ success: false, message: "AVD deletion failed: first second" });
  });

  for (const operation of ["create", "delete"] as const) {
    for (const stream of ["stdout", "stderr"] as const) {
      test(`${operation} bounds multi-chunk ${stream} failure diagnostics`, async () => {
        const { client, child } = createClient();
        const pending =
          operation === "create"
            ? client.createAvd({ name: "pixel", package: "unused" })
            : client.deleteAvd("pixel");
        await new Promise<void>((resolve) => setImmediate(resolve));
        // Fill stdout in both cases; fill stderr only when it is the selected diagnostic.
        for (let chunk = 0; chunk < 4; chunk++) {
          child.stdoutText("x".repeat(10_000));
          if (stream === "stderr") {
            child.stderrText("e".repeat(10_000));
          }
        }
        child.stdoutText("stdout-tail-marker");
        if (stream === "stderr") {
          child.stderrText("stderr-tail-marker");
        }
        child.close(1);
        const result = await pending;
        expect(result.success).toBe(false);
        expect(result.message).toBe(
          `AVD ${operation === "create" ? "creation" : "deletion"} failed: ${(stream === "stdout"
            ? "x"
            : "e"
          ).repeat(16_384)}\n[output truncated]`,
        );
        expect(result.message.length).toBeLessThanOrEqual(16_384 + 50);
        expect(result.message).not.toContain("tail-marker");
      });
    }
  }

  test("does not mark complete stderr diagnostics when only stdout was truncated", async () => {
    const { client, child } = createClient();
    const pending = client.deleteAvd("pixel");
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.stdoutText("x".repeat(20_000));
    child.stderrText("complete stderr");
    child.close(1);
    expect((await pending).message).toBe("AVD deletion failed: complete stderr");
  });

  for (const command of ["avd", "device"] as const) {
    test(`refuses to parse truncated list ${command} stdout`, async () => {
      const { client, child } = createClient();
      const pending = command === "avd" ? client.listDeviceImages() : client.listDevices();
      await new Promise<void>((resolve) => setImmediate(resolve));
      child.stdoutText("x".repeat(600_000));
      child.stdoutText("x".repeat(600_000));
      child.close(0);
      await expect(pending).rejects.toBeInstanceOf(ActionableError);
      await expect(pending).rejects.toThrow(
        `avdmanager list ${command} output exceeded 1048576 characters and was truncated; refusing to parse partial output`,
      );
    });

    test(`reports nonzero list ${command} failure before stdout truncation`, async () => {
      const { client, child } = createClient();
      const pending = command === "avd" ? client.listDeviceImages() : client.listDevices();
      await new Promise<void>((resolve) => setImmediate(resolve));
      child.stdoutText("x".repeat(1_048_577));
      child.stderrText("configuration failed");
      child.close(1);
      await expect(pending).rejects.toThrow(
        `Failed to list ${command === "avd" ? "AVDs" : "devices"}: configuration failed`,
      );
      await expect(pending).rejects.not.toBeInstanceOf(ActionableError);
    });
  }

  test("parses complete device stdout above 16 KiB despite truncated stderr", async () => {
    const { client, child } = createClient();
    const pending = client.listDevices();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(listDeviceOutput.length).toBeLessThan(1_048_576);
    child.stdoutText("\n".repeat(16_384));
    child.stdoutText(listDeviceOutput);
    child.stderrText("e".repeat(20_000));
    child.close(0);
    expect(await pending).toHaveLength(96);
  });

  test("parses cmdline-tools 23.0 device profiles with whitespace around field colons", async () => {
    const { client, child } = createClient();
    const pending = client.listDevices();
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.stdoutText(listDeviceOutput);
    child.close(0);

    const devices = await pending;
    expect(devices).toHaveLength(96);
    expect(devices.find(({ id }) => id === "ai_glasses_displayless")).toMatchObject({
      name: "Audio Glasses",
      oem: "Google",
    });
    expect(devices.find(({ id }) => id === "Galaxy Nexus")).toMatchObject({
      name: "Galaxy Nexus",
      oem: "Google",
    });
    expect(devices.find(({ id }) => id === "Nexus 5")?.oem).toBe("Google");
    expect(devices.find(({ id }) => id === "3.7in WVGA (Nexus One)")).toMatchObject({
      name: '3.7" WVGA (Nexus One)',
      oem: "Generic",
    });
    expect(devices.find(({ id }) => id === "13.5in Freeform")).toMatchObject({
      name: '13.5" Freeform',
      oem: "Generic",
    });
    expect(devices.every(({ id, oem }) => !/^\d+ or /.test(id) && Boolean(oem?.trim()))).toBe(true);
  });

  test("passes AVD names and paths as discrete argv values", async () => {
    const { client, child, calls } = createClient();
    const pending = client.createAvd({
      name: "pixel; touch should-not-run",
      package: "system-images;android-36;google_apis;x86_64",
      path: "/tmp/AVD name;$(nope)",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.close(0);

    await expect(pending).resolves.toMatchObject({ success: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      args: [
        "create",
        "avd",
        "-n",
        "pixel; touch should-not-run",
        "-k",
        "system-images;android-36;google_apis;x86_64",
        "-p",
        "/tmp/AVD name;$(nope)",
      ],
    });
    expect(typeof calls[0]?.command).toBe("string");
    expect(normalizePath(calls[0]?.command as string)).toBe(
      "/sdk/cmdline-tools/latest/bin/avdmanager",
    );
    expect(child.stdinWrites).toEqual(["\n"]);
    expect(child.stdinEnded).toBe(true);
  });

  test("executes a Windows batch file through cmd without enabling a shell", async () => {
    const { client, child, calls } = createClient({
      detectAndroidCommandLineTools: async () => [
        {
          path: "/Program Files/Android/Sdk/cmdline-tools/latest",
          source: "manual",
          available_tools: ["avdmanager"],
        },
      ],
      existsSync: (path) => path.endsWith("avdmanager.bat") || path.endsWith("system-images"),
      platform: "win32",
    });
    const pending = client.listDeviceImages();
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.close(0);

    await expect(pending).resolves.toEqual([]);
    expect(normalizePath(calls[0]?.args[4] ?? "")).toBe(
      '""/Program Files/Android/Sdk/cmdline-tools/latest/bin/avdmanager.bat" "list" "avd""',
    );
    expect(calls[0]).toMatchObject({
      command: "cmd.exe",
      shell: false,
    });
  });

  test("quotes Windows batch arguments before passing them to cmd", async () => {
    const { client, child, calls } = createClient({
      existsSync: (path) => path.endsWith("avdmanager.bat") || path.endsWith("system-images"),
      platform: "win32",
    });
    const pending = client.createAvd({
      name: "pixel & echo injected %PATH%!",
      package: "system-images;android-36;google_apis;x86_64",
      path: "C:\\AVDs\\with & percent%",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.close(0);

    await expect(pending).resolves.toMatchObject({ success: true });
    expect(calls[0]?.shell).toBe(false);
    expect(calls[0]?.args.at(-1)).toContain('"pixel & echo injected %%PATH%%!"');
    expect(calls[0]?.args.at(-1)).toContain('"C:\\AVDs\\with & percent%%"');
  });

  test("rejects Windows batch arguments that could terminate quoting", async () => {
    const { client, calls } = createClient({
      existsSync: (path) => path.endsWith("avdmanager.bat") || path.endsWith("system-images"),
      platform: "win32",
    });

    await expect(
      client.createAvd({
        name: 'pixel" & echo injected',
        package: "system-images;android-36;google_apis;x86_64",
      }),
    ).resolves.toMatchObject({
      success: false,
      message: expect.stringContaining("cannot contain Windows command-line quotes or newlines"),
    });
    expect(calls).toEqual([]);
  });

  test("requires avdmanager without coupling AVD operations to sdkmanager", async () => {
    const validations: string[][] = [];
    const { client, child } = createClient({
      validateRequiredTools: (_location, tools) => {
        validations.push([...tools]);
        return { valid: true, missing: [] };
      },
    });
    const pending = client.listDeviceImages();
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.close(0);

    await expect(pending).resolves.toEqual([]);
    expect(validations).toEqual([["avdmanager"]]);
  });

  test("rejects null exits and retains stderr-only diagnostics", async () => {
    const { client, child } = createClient();
    const pending = client.listDeviceImages();
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.stderrText("configuration failed");
    child.close(null);

    await expect(pending).rejects.toThrow("configuration failed");
  });

  test("cancels the child once and waits for process close", async () => {
    const { client, child } = createClient();
    const abort = new AbortController();
    const pending = client.listDeviceImages({ signal: abort.signal });
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    abort.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    child.close(0);

    await expect(pending).rejects.toThrow("cancelled");
    expect(child.kills).toEqual(["SIGTERM"]);
  });

  test("terminates a timed-out list command and waits for process exit", async () => {
    const { client, child, timer } = createClient();
    const pending = client.listDeviceImages();
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    timer.advanceTime(60_000);
    await Promise.resolve();
    expect(settled).toBe(false);
    child.exit(0);

    await expect(pending).rejects.toThrow("timed out after 60000ms");
    expect(child.kills).toEqual(["SIGTERM"]);
  });

  test("escalates and bounds termination when a timed-out process never exits", async () => {
    const { client, child, timer } = createClient();
    const pending = client.listDeviceImages();
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    timer.advanceTime(60_000);
    await Promise.resolve();
    expect(child.kills).toEqual(["SIGTERM"]);
    expect(settled).toBe(false);

    timer.advanceTime(1_000);
    await Promise.resolve();
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(settled).toBe(false);

    timer.advanceTime(1_000);
    await expect(pending).rejects.toThrow("timed out after 60000ms");
  });
});
