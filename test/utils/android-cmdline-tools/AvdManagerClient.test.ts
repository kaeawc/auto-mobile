import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { AvdManagerClient } from "../../../src/utils/android-cmdline-tools/AvdManagerClient";
import { FakeTimer } from "../../fakes/FakeTimer";

const normalizePath = (value: string): string => value.replace(/\\/g, "/");

class FakeChild {
  readonly stdout = { on: (_event: string, callback: (data: Buffer) => void) => { this.stdoutCallback = callback; } };
  readonly stderr = { on: (_event: string, callback: (data: Buffer) => void) => { this.stderrCallback = callback; } };
  readonly stdin = {
    write: (value: string) => { this.stdinWrites.push(value); },
    end: () => { this.stdinEnded = true; }
  };
  readonly kills: NodeJS.Signals[] = [];
  readonly stdinWrites: string[] = [];
  stdinEnded = false;
  private stdoutCallback?: (data: Buffer) => void;
  private stderrCallback?: (data: Buffer) => void;
  private closeCallback?: (code: number | null) => void;
  private errorCallback?: (error: Error) => void;

  on(event: string, callback: (value: never) => void): this {
    if (event === "close") {this.closeCallback = callback as (code: number | null) => void;}
    if (event === "error") {this.errorCallback = callback as (error: Error) => void;}
    return this;
  }

  kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal);
    return true;
  }

  close(code: number | null): void { this.closeCallback?.(code); }
  stdoutText(value: string): void { this.stdoutCallback?.(Buffer.from(value)); }
  stderrText(value: string): void { this.stderrCallback?.(Buffer.from(value)); }
  fail(error: Error): void { this.errorCallback?.(error); }
}

function createClient(overrides: Partial<ConstructorParameters<typeof AvdManagerClient>[0]> = {}) {
  const child = new FakeChild();
  const timer = new FakeTimer();
  const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv; shell?: string | boolean }> = [];
  const client = new AvdManagerClient({
    detectAndroidCommandLineTools: async () => [{
      path: "/sdk/cmdline-tools/latest",
      source: "manual",
      available_tools: ["avdmanager"]
    }],
    getBestAndroidToolsLocation: locations => locations[0] ?? null,
    validateRequiredTools: () => ({ valid: true, missing: [] }),
    existsSync: path => path.endsWith("avdmanager") || path.endsWith("system-images"),
    spawn: (command, args, options) => {
      calls.push({ command, args, env: options.env, shell: options.shell });
      return child as unknown as ChildProcess;
    },
    logger: { info() {}, warn() {}, error() {} },
    timer,
    environment: { ANDROID_HOME: "/sdk" },
    platform: "linux",
    ...overrides
  });
  return { client, child, timer, calls };
}

describe("AvdManagerClient", () => {
  test("passes AVD names and paths as discrete argv values", async () => {
    const { client, child, calls } = createClient();
    const pending = client.createAvd({
      name: "pixel; touch should-not-run",
      package: "system-images;android-36;google_apis;x86_64",
      path: "/tmp/AVD name;$(nope)"
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    child.close(0);

    await expect(pending).resolves.toMatchObject({ success: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      args: [
        "create", "avd", "-n", "pixel; touch should-not-run", "-k",
        "system-images;android-36;google_apis;x86_64", "-p", "/tmp/AVD name;$(nope)"
      ]
    });
    expect(typeof calls[0]?.command).toBe("string");
    expect(normalizePath(calls[0]?.command as string)).toBe("/sdk/cmdline-tools/latest/bin/avdmanager");
    expect(child.stdinWrites).toEqual(["\n"]);
    expect(child.stdinEnded).toBe(true);
  });

  test("uses the Windows batch executable when that is the resolved tool", async () => {
    const { client, child, calls } = createClient({
      existsSync: path => path.endsWith("avdmanager.bat") || path.endsWith("system-images"),
      platform: "win32"
    });
    const pending = client.listDeviceImages();
    await new Promise<void>(resolve => setImmediate(resolve));
    child.close(0);

    await expect(pending).resolves.toEqual([]);
    expect(normalizePath(calls[0]?.command ?? "")).toBe("/sdk/cmdline-tools/latest/bin/avdmanager.bat");
    expect(calls[0]).toMatchObject({ args: ["list", "avd"], shell: true });
  });

  test("requires avdmanager without coupling AVD operations to sdkmanager", async () => {
    const validations: string[][] = [];
    const { client, child } = createClient({
      validateRequiredTools: (_location, tools) => {
        validations.push([...tools]);
        return { valid: true, missing: [] };
      }
    });
    const pending = client.listDeviceImages();
    await new Promise<void>(resolve => setImmediate(resolve));
    child.close(0);

    await expect(pending).resolves.toEqual([]);
    expect(validations).toEqual([["avdmanager"]]);
  });

  test("rejects null exits and retains stderr-only diagnostics", async () => {
    const { client, child } = createClient();
    const pending = client.listDeviceImages();
    await new Promise<void>(resolve => setImmediate(resolve));
    child.stderrText("configuration failed");
    child.close(null);

    await expect(pending).rejects.toThrow("configuration failed");
  });

  test("cancels the child once and ignores a late close", async () => {
    const { client, child } = createClient();
    const abort = new AbortController();
    const pending = client.listDeviceImages({ signal: abort.signal });
    await new Promise<void>(resolve => setImmediate(resolve));
    abort.abort();
    child.close(0);

    await expect(pending).rejects.toThrow("cancelled");
    expect(child.kills).toEqual(["SIGTERM"]);
  });

  test("terminates a timed-out list command and ignores its late close", async () => {
    const { client, child, timer } = createClient();
    const pending = client.listDeviceImages();
    await new Promise<void>(resolve => setImmediate(resolve));
    timer.advanceTime(60_000);
    child.close(0);

    await expect(pending).rejects.toThrow("timed out after 60000ms");
    expect(child.kills).toEqual(["SIGTERM"]);
  });
});
