import { afterEach, describe, expect, test } from "bun:test";
import { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import type { ExecResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";

const createExecResult = (stdout: string, stderr: string = ""): ExecResult => ({
  stdout,
  stderr,
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (s: string) => stdout.includes(s),
});

describe("AdbClient remote server configuration", () => {
  const savedHost = process.env.AUTOMOBILE_ADB_SERVER_HOST;
  const savedPort = process.env.AUTOMOBILE_ADB_SERVER_PORT;

  afterEach(() => {
    if (savedHost === undefined) {
      delete process.env.AUTOMOBILE_ADB_SERVER_HOST;
    } else {
      process.env.AUTOMOBILE_ADB_SERVER_HOST = savedHost;
    }
    if (savedPort === undefined) {
      delete process.env.AUTOMOBILE_ADB_SERVER_PORT;
    } else {
      process.env.AUTOMOBILE_ADB_SERVER_PORT = savedPort;
    }
  });

  test("ignores Docker host ADB server environment variables", async () => {
    process.env.AUTOMOBILE_ADB_SERVER_HOST = "host.docker.internal";
    process.env.AUTOMOBILE_ADB_SERVER_PORT = "5037";

    const execAsync = async (file: string, args: string[]): Promise<ExecResult> => {
      if (file === "which" && args[0] === "adb") {
        return createExecResult("/opt/android-sdk/platform-tools/adb\n");
      }
      return createExecResult("Android Debug Bridge version 1.0.41\n");
    };

    const client = new AdbClient(null, execAsync, null, undefined, new FakeTimer());

    const command = await client.getBaseCommandParts();
    expect(command.baseArgs).toEqual([]);
  });
});
