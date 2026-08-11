import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import {
  readSdkManagerVersion,
  SdkManagerClient,
} from "../../../src/utils/android-cmdline-tools/SdkManagerClient";
import { FakeTimer } from "../../fakes/FakeTimer";

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
  private errorCallback?: (error: Error) => void;

  on(event: string, callback: (value: never) => void): this {
    if (event === "close") {
      this.closeCallback = callback as (code: number | null) => void;
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

  stdoutText(value: string): void {
    this.stdoutCallback?.(Buffer.from(value));
  }
  stderrText(value: string): void {
    this.stderrCallback?.(Buffer.from(value));
  }
  close(code: number | null): void {
    this.closeCallback?.(code);
  }
  error(error: Error): void {
    this.errorCallback?.(error);
  }
}

function createClient(overrides: Partial<ConstructorParameters<typeof SdkManagerClient>[0]> = {}) {
  const child = new FakeChild();
  const timer = new FakeTimer();
  const spawns: Array<{ command: string; args: string[]; options: unknown }> = [];
  const client = new SdkManagerClient({
    spawn: (command, args, options) => {
      spawns.push({ command, args, options });
      return child as unknown as ChildProcess;
    },
    existsSync: () => true,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    detectAndroidCommandLineTools: async () => [
      {
        path: "/sdk/cmdline-tools/latest",
        source: "manual",
        available_tools: ["sdkmanager"],
      },
    ],
    getAndroidHomeWithSystemImages: () => null,
    getBestAndroidToolsLocation: (locations) => locations[0] ?? null,
    validateRequiredTools: () => ({ valid: true, missing: [] }),
    timer,
    environment: {},
    platform: "linux",
    ...overrides,
  });
  return { client, child, timer, spawns };
}

async function settleSpawn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("SdkManagerClient", () => {
  test("lists packages through the resolved sdkmanager argv boundary", async () => {
    const { client, child, spawns } = createClient();
    const pending = client.list();
    await settleSpawn();
    child.stdoutText("Installed packages:\n");
    child.close(0);

    await expect(pending).resolves.toMatchObject({ stdout: "Installed packages:\n", exitCode: 0 });
    expect(spawns).toEqual([
      {
        command: join("/sdk", "cmdline-tools", "latest", "bin", "sdkmanager"),
        args: ["--list"],
        options: expect.objectContaining({ shell: false }),
      },
    ]);
  });

  test("reads the sdkmanager version through the same argv boundary", async () => {
    const { client, child, spawns } = createClient();
    const pending = client.getVersion();
    await settleSpawn();
    child.stdoutText("13.0\n");
    child.close(0);

    await expect(pending).resolves.toMatchObject({ stdout: "13.0\n", exitCode: 0 });
    expect(spawns[0]?.args).toEqual(["--version"]);
    expect(spawns[0]?.options).toEqual(expect.objectContaining({ shell: false }));
  });

  test("probes sdkmanager from a cmdline-tools-only bootstrap SDK", async () => {
    const { client, child, spawns } = createClient({
      existsSync: (path) => {
        const normalized = path.replaceAll("\\", "/");
        return normalized.endsWith("/sdkmanager") || normalized === "/sdk";
      },
    });
    const pending = client.getVersion();
    await settleSpawn();
    child.stdoutText("13.0\n");
    child.close(0);

    await expect(pending).resolves.toMatchObject({ stdout: "13.0\n", exitCode: 0 });
    expect(spawns[0]?.command.replaceAll("\\", "/")).toBe(
      "/sdk/cmdline-tools/latest/bin/sdkmanager",
    );
  });

  test("does not treat a failed sdkmanager probe diagnostic as a version", async () => {
    await expect(
      readSdkManagerVersion({
        getVersion: async () => ({
          stdout: "",
          stderr: "Requires Java 17",
          exitCode: 1,
          outputTruncated: false,
        }),
      }),
    ).resolves.toBeNull();
  });

  test("parses the standalone sdkmanager version after warning output", async () => {
    await expect(
      readSdkManagerVersion({
        getVersion: async () => ({
          stdout: "Warning: SDK XML version 3 is too old.\n13.0\n",
          stderr: "",
          exitCode: 0,
          outputTruncated: false,
        }),
      }),
    ).resolves.toBe("13.0");
  });

  test("passes the selected tools location to the version probe", async () => {
    const location = {
      path: "/selected/cmdline-tools/latest",
      source: "manual" as const,
      available_tools: ["sdkmanager"],
    };
    let receivedLocation: unknown;
    await expect(
      readSdkManagerVersion(
        {
          getVersion: async (options) => {
            receivedLocation = options?.location;
            return { stdout: "13.0\n", stderr: "", exitCode: 0, outputTruncated: false };
          },
        },
        location,
      ),
    ).resolves.toBe("13.0");
    expect(receivedLocation).toEqual(location);
  });

  test("does not truncate the sdkmanager catalogue by default", async () => {
    const { client, child } = createClient();
    const output = "available package\n".repeat(2_000);
    const pending = client.list();
    await settleSpawn();
    child.stdoutText(output);
    child.close(0);

    await expect(pending).resolves.toMatchObject({
      stdout: output,
      outputTruncated: false,
      exitCode: 0,
    });
  });

  test("keeps list diagnostics bounded while preserving the catalogue", async () => {
    const { client, child } = createClient();
    const catalogue = "available package\n".repeat(2_000);
    const diagnostics = "sdkmanager failure\n".repeat(2_000);
    const pending = client.list();
    await settleSpawn();
    child.stdoutText(catalogue);
    child.stderrText(diagnostics);
    child.close(1);

    const result = await pending;
    expect(result.stdout).toBe(catalogue);
    expect(result.stderr).toHaveLength(16_384);
    expect(result.outputTruncated).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  test("writes repeated license confirmation to stdin without shell interpolation", async () => {
    const { client, child, spawns } = createClient();
    const pending = client.acceptLicenses();
    await settleSpawn();
    child.close(0);

    await expect(pending).resolves.toMatchObject({ exitCode: 0 });
    expect(spawns[0]?.args).toEqual(["--licenses"]);
    expect(child.stdinWrites).toEqual(["y\n".repeat(20)]);
    expect(child.stdinEnded).toBe(true);
  });

  test("executes a Windows batch sdkmanager through cmd without enabling a shell", async () => {
    const { client, child, spawns } = createClient({
      existsSync: (path) => !/[\\/]sdkmanager$/.test(path),
      environment: { ComSpec: "C:/Windows/System32/cmd.exe" },
      platform: "win32",
    });
    const pending = client.list();
    await settleSpawn();
    child.close(0);

    await expect(pending).resolves.toMatchObject({ exitCode: 0 });
    expect(spawns).toEqual([
      {
        command: "C:/Windows/System32/cmd.exe",
        args: [
          "/d",
          "/v:off",
          "/s",
          "/c",
          `""${join("/sdk", "cmdline-tools", "latest", "bin", "sdkmanager.bat")}" "--list""`,
        ],
        options: expect.objectContaining({ shell: false }),
      },
    ]);
  });

  test("keeps a package name as one argv element and supports opted-in license input", async () => {
    const { client, child, spawns } = createClient();
    const packageName = "system-images;android-35;google_apis;arm64-v8a";
    const pending = client.installPackage(packageName, { acceptLicenses: true });
    await settleSpawn();
    child.close(0);

    await expect(pending).resolves.toMatchObject({ exitCode: 0 });
    expect(spawns[0]?.args).toEqual([packageName]);
    expect(child.stdinWrites).toEqual(["y\n".repeat(10)]);
  });

  test("gives the network-backed catalogue fetch a longer default budget than a local command", async () => {
    const { client, child, timer } = createClient();
    const pending = client.list({ terminationGraceMs: 1_000 });
    await settleSpawn();

    timer.advanceTime(60_000);
    expect(child.kills).toEqual([]);

    timer.advanceTime(240_000);
    expect(child.kills).toEqual(["SIGTERM"]);
    timer.advanceTime(1_000);
    child.close(null);

    await expect(pending).rejects.toThrow("timed out after 300000ms");
  });

  test("terminates a slow install, then escalates after its grace period", async () => {
    const { client, child, timer } = createClient();
    const pending = client.installPackage("system-images;android-35;google_apis;arm64-v8a", {
      timeoutMs: 600_000,
      terminationGraceMs: 1_000,
    });
    await settleSpawn();
    timer.advanceTime(600_000);
    expect(child.kills).toEqual(["SIGTERM"]);
    timer.advanceTime(1_000);
    child.close(null);

    await expect(pending).rejects.toThrow("timed out after 600000ms");
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("cancels once, escalates if needed, and ignores a late close", async () => {
    const { client, child, timer } = createClient();
    const abort = new AbortController();
    const pending = client.list({ signal: abort.signal, terminationGraceMs: 1_000 });
    await settleSpawn();
    abort.abort();
    timer.advanceTime(1_000);
    child.close(0);

    await expect(pending).rejects.toThrow("cancelled");
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("bounds and redacts noisy diagnostics", async () => {
    const { client, child } = createClient();
    const pending = client.list({ maxOutputChars: 24 });
    await settleSpawn();
    child.stderrText("token=super-secret-value ".repeat(4));
    child.close(1);

    const result = await pending;
    const stderr = result.stderr;
    expect(result).toMatchObject({
      stderr: expect.stringContaining("[REDACTED]"),
      outputTruncated: true,
      exitCode: 1,
    });
    expect(stderr.includes("super-secret-value")).toBe(false);
  });

  test("redacts the sdkmanager child home directory", async () => {
    const { client, child } = createClient({
      environment: { HOME: "/workspace/sdk-user" },
    });
    const pending = client.list();
    await settleSpawn();
    child.stderrText("/workspace/sdk-user/.android/repositories.cfg\n");
    child.close(1);

    await expect(pending).resolves.toMatchObject({
      stderr: "~/.android/repositories.cfg\n",
      exitCode: 1,
    });
  });

  test("explains the effective SDK root when Homebrew tools and Android home disagree", async () => {
    const warnings: string[] = [];
    const { client, child } = createClient({
      logger: { info: () => {}, warn: (message) => warnings.push(message), error: () => {} },
      environment: { ANDROID_HOME: "/sdk" },
      getAndroidHomeWithSystemImages: () => ({
        androidHome: "/sdk",
        systemImagesPath: "/sdk/system-images",
      }),
      detectAndroidCommandLineTools: async () => [
        {
          path: "/opt/homebrew/share/android-commandlinetools",
          source: "homebrew",
          available_tools: ["sdkmanager"],
        },
      ],
    });
    const pending = client.list();
    await settleSpawn();
    child.close(0);

    await expect(pending).resolves.toMatchObject({ exitCode: 0 });
    expect(warnings.join(" ")).toContain("ANDROID_HOME");
    expect(warnings.join(" ")).toContain("sdkmanager");
  });
});
