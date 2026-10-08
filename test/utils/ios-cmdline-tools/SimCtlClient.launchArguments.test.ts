import { expect, spyOn, test } from "bun:test";
import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { logger } from "../../../src/utils/logger";

test("simctl launch passes app arguments as argv after the bundle id", async () => {
  const calls: string[][] = [];
  const client = new SimCtlClient(
    { deviceId: "simulator-udid", name: "iPhone", platform: "ios" },
    async (_file, args) => {
      calls.push(args);
      const stdout = "com.example.app: 123";
      return {
        stdout,
        stderr: "",
        toString: () => stdout,
        trim: () => stdout.trim(),
        includes: (value: string) => stdout.includes(value),
      };
    },
  );

  const result = await client.launchApp("com.example.app", {
    launchArguments: ["--allow-storage-mutations", "value with spaces"],
  });

  expect(result).toMatchObject({ success: true, pid: 123 });
  expect(calls).toEqual([
    [
      "simctl",
      "launch",
      "simulator-udid",
      "com.example.app",
      "--allow-storage-mutations",
      "value with spaces",
    ],
  ]);
});

test("simctl launch redacts the token from responses and logs", async () => {
  const warn = spyOn(logger, "warn");
  const debug = spyOn(logger, "debug");
  const token = "private-launch-token";
  const client = new SimCtlClient(
    { deviceId: "simulator-udid", name: "iPhone", platform: "ios" },
    async () => {
      throw new Error(`launch failed for ${token}`);
    },
  );
  try {
    const result = await client.launchApp("com.example.app", {
      launchArguments: ["--allow-storage-mutations", "--automobile-mutation-token", token],
    });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify([...warn.mock.calls, ...debug.mock.calls])).not.toContain(token);
  } finally {
    warn.mockRestore();
    debug.mockRestore();
  }
});

function recordingExec() {
  const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv; argc: number }> = [];
  const exec = async (
    _file: string,
    args: string[],
    _maxBuffer?: number,
    _signal?: AbortSignal,
    env?: NodeJS.ProcessEnv,
  ) => {
    // Rest-free arity check: an env-less launch must keep the four-argument call shape.
    calls.push({ args, env, argc: env === undefined ? 4 : 5 });
    const stdout = "com.example.app: 456";
    return {
      stdout,
      stderr: "",
      toString: () => stdout,
      trim: () => stdout.trim(),
      includes: (value: string) => stdout.includes(value),
    };
  };
  return { calls, exec };
}

const device = { deviceId: "simulator-udid", name: "iPhone", platform: "ios" as const };

test("simctl launch passes SIMCTL_CHILD_ variables over the host environment", async () => {
  const { calls, exec } = recordingExec();
  const client = new SimCtlClient(device, exec);

  const result = await client.launchApp("com.example.app", {
    foregroundIfRunning: false,
    environment: { SIMCTL_CHILD_AUTOMOBILE_OVERLAY_PORT: "8770" },
  });

  expect(result).toMatchObject({ success: true, pid: 456 });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.args).toEqual(["simctl", "launch", "simulator-udid", "com.example.app"]);
  expect(calls[0]!.env?.SIMCTL_CHILD_AUTOMOBILE_OVERLAY_PORT).toBe("8770");
  // The child still gets the host environment (PATH, DEVELOPER_DIR, ...).
  expect(calls[0]!.env?.PATH).toBe(process.env.PATH);
});

test("simctl launch without an environment inherits the host env unchanged", async () => {
  const { calls, exec } = recordingExec();
  const client = new SimCtlClient(device, exec);

  await client.launchApp("com.example.app", { environment: {} });
  await client.launchApp("com.example.app");

  expect(calls.map((call) => call.argc)).toEqual([4, 4]);
});

test("simctl launch rejects environment keys simctl would not forward", async () => {
  const { calls, exec } = recordingExec();
  const client = new SimCtlClient(device, exec);

  const result = await client.launchApp("com.example.app", {
    environment: { DYLD_INSERT_LIBRARIES: "/tmp/agent.dylib" },
  });

  expect(result.success).toBe(false);
  expect(result.error).toContain("must start with SIMCTL_CHILD_: DYLD_INSERT_LIBRARIES");
  expect(calls).toHaveLength(0);
});
