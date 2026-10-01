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
