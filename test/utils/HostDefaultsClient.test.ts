import { describe, expect, test } from "bun:test";
import {
  DefaultHostDefaultsClient,
  type HostDefaultsClientDependencies,
} from "../../src/utils/HostDefaultsClient";
import type { HostCommandExecutor, HostCommandOptions } from "../../src/utils/HostCommandExecutor";
import type { ExecResult } from "../../src/models";

function execResult(stdout: string, stderr = ""): ExecResult {
  return {
    stdout,
    stderr,
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (search: string) => stdout.includes(search),
  };
}

interface RecordedCall {
  file: string;
  args: string[];
  options?: HostCommandOptions;
}

function recordingExecutor(
  respond: (file: string, args: string[]) => ExecResult | Promise<ExecResult>
): { executor: HostCommandExecutor; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const executor: HostCommandExecutor = {
    async executeCommand(file, args = [], options) {
      calls.push({ file, args, options });
      return respond(file, args);
    },
  };
  return { executor, calls };
}

function deps(
  overrides: Partial<HostDefaultsClientDependencies> & Pick<HostDefaultsClientDependencies, "executor">
): HostDefaultsClientDependencies {
  return {
    platform: "darwin",
    logger: { debug: () => {} },
    ...overrides,
  };
}

describe("HostDefaultsClient", () => {
  test("reports macOS support only on darwin", () => {
    const { executor } = recordingExecutor(() => execResult(""));
    expect(new DefaultHostDefaultsClient(deps({ executor, platform: "darwin" })).isSupported()).toBe(true);
    expect(new DefaultHostDefaultsClient(deps({ executor, platform: "linux" })).isSupported()).toBe(false);
    expect(new DefaultHostDefaultsClient(deps({ executor, platform: "win32" })).isSupported()).toBe(false);
  });

  test("returns the trimmed dark value via argv against the global domain", async () => {
    const { executor, calls } = recordingExecutor(() => execResult("Dark\n"));
    const client = new DefaultHostDefaultsClient(deps({ executor }));

    expect(await client.readGlobal("AppleInterfaceStyle")).toBe("Dark");
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("defaults");
    expect(calls[0].args).toEqual(["read", "-g", "AppleInterfaceStyle"]);
    expect(calls[0].options?.timeoutMs).toBe(2000);
  });

  test("returns the trimmed light value", async () => {
    const { executor } = recordingExecutor(() => execResult("Light"));
    const client = new DefaultHostDefaultsClient(deps({ executor }));
    expect(await client.readGlobal("AppleInterfaceStyle")).toBe("Light");
  });

  test("treats an empty value as unset (null)", async () => {
    const { executor } = recordingExecutor(() => execResult("   \n"));
    const client = new DefaultHostDefaultsClient(deps({ executor }));
    expect(await client.readGlobal("AppleInterfaceStyle")).toBeNull();
  });

  test("returns null and logs when the command fails (unset key or absent CLI)", async () => {
    const messages: string[] = [];
    const executor: HostCommandExecutor = {
      async executeCommand() {
        throw new Error("The domain/default pair does not exist");
      },
    };
    const client = new DefaultHostDefaultsClient(
      deps({ executor, logger: { debug: (message: string) => messages.push(message) } })
    );

    expect(await client.readGlobal("AppleInterfaceStyle")).toBeNull();
    expect(messages.some(message => message.includes("AppleInterfaceStyle"))).toBe(true);
  });

  test("does not execute anything on non-macOS hosts", async () => {
    const { executor, calls } = recordingExecutor(() => execResult("Dark"));
    const client = new DefaultHostDefaultsClient(deps({ executor, platform: "linux" }));

    expect(await client.readGlobal("AppleInterfaceStyle")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("forwards an explicit timeout and abort signal", async () => {
    const { executor, calls } = recordingExecutor(() => execResult("Dark"));
    const client = new DefaultHostDefaultsClient(deps({ executor }));
    const controller = new AbortController();

    await client.readGlobal("AppleInterfaceStyle", { timeoutMs: 500, signal: controller.signal });
    expect(calls[0].options?.timeoutMs).toBe(500);
    expect(calls[0].options?.signal).toBe(controller.signal);
  });
});
