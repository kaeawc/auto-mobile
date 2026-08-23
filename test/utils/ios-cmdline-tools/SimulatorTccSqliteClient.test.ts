import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ExecResult } from "../../../src/models";
import type {
  HostCommandExecutor,
  HostCommandOptions,
} from "../../../src/utils/HostCommandExecutor";
import {
  SimulatorTccSqliteClient,
  type TccDatabaseFileSystem,
} from "../../../src/utils/ios-cmdline-tools/SimulatorTccSqliteClient";
import { FakeTimer } from "../../fakes/FakeTimer";

const DEVICE_ID = "12345678-1234-1234-1234-123456789ABC";

function result(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (search: string) => stdout.includes(search),
  };
}

class FakeTccFileSystem implements TccDatabaseFileSystem {
  readonly paths: string[] = [];
  error: Error | null = null;
  isFile = true;

  async stat(path: string): Promise<{ isFile(): boolean }> {
    this.paths.push(path);
    if (this.error) {
      throw this.error;
    }
    return { isFile: () => this.isFile };
  }
}

class FakeSqliteExecutor implements HostCommandExecutor {
  readonly calls: Array<{ file: string; args: string[]; options: HostCommandOptions | undefined }> =
    [];
  response: ExecResult = result("[]");
  error: Error | null = null;
  onExecute: ((options: HostCommandOptions | undefined) => Promise<ExecResult>) | null = null;

  async executeCommand(
    file: string,
    args: string[] = [],
    options?: HostCommandOptions,
  ): Promise<ExecResult> {
    this.calls.push({ file, args, options });
    if (this.onExecute) {
      return this.onExecute(options);
    }
    if (this.error) {
      throw this.error;
    }
    return this.response;
  }
}

describe("SimulatorTccSqliteClient", () => {
  test("owns TCC path resolution and issues parameterized sqlite argv queries", async () => {
    const executor = new FakeSqliteExecutor();
    const fileSystem = new FakeTccFileSystem();
    executor.onExecute = async () => {
      const call = executor.calls.at(-1);
      return call?.args.at(-1) === "pragma table_info(access);"
        ? result(
            JSON.stringify([
              { name: "service" },
              { name: "client" },
              { name: "auth_value" },
              { name: "prompt_count" },
            ]),
          )
        : result(
            JSON.stringify([
              {
                service: "kTCCServiceCamera",
                client: "com.example.app",
                auth_value: 2,
                prompt_count: 1,
              },
            ]),
          );
    };
    const client = new SimulatorTccSqliteClient({
      executor,
      fileSystem,
      homeDirectory: "/Users/test user",
    });
    const databasePath = join(
      "/Users/test user",
      "Library",
      "Developer",
      "CoreSimulator",
      "Devices",
      DEVICE_ID,
      "data",
      "Library",
      "TCC",
      "TCC.db",
    );

    const rows = await client.readPermissions(DEVICE_ID, "com.example.app", ["kTCCServiceCamera"]);

    expect(rows).toEqual([
      {
        service: "kTCCServiceCamera",
        client: "com.example.app",
        auth_value: 2,
        prompt_count: 1,
      },
    ]);
    expect(fileSystem.paths).toEqual([databasePath]);
    expect(executor.calls).toHaveLength(2);
    expect(executor.calls[0]).toMatchObject({
      file: "sqlite3",
      args: ["-json", databasePath, "pragma table_info(access);"],
    });
    expect(executor.calls[1]?.args).toEqual([
      "-json",
      "-cmd",
      ".parameter init",
      "-cmd",
      '.parameter set :appId "com.example.app"',
      "-cmd",
      '.parameter set :service0 "kTCCServiceCamera"',
      databasePath,
      [
        "select service, client, auth_value, prompt_count",
        "from access",
        "where client = :appId and service in (:service0);",
      ].join("\n"),
    ]);
  });

  test("encodes apostrophes and quotes for sqlite dot-command parameters", async () => {
    const executor = new FakeSqliteExecutor();
    executor.onExecute = async () =>
      executor.calls.at(-1)?.args.at(-1) === "pragma table_info(access);"
        ? result(JSON.stringify([{ name: "service" }, { name: "client" }]))
        : result("[]");
    const client = new SimulatorTccSqliteClient({
      executor,
      fileSystem: new FakeTccFileSystem(),
      homeDirectory: "/Users/tester",
    });

    await client.readPermissions(DEVICE_ID, "com.example.o'hara", ['service"quoted']);

    expect(executor.calls[1]?.args).toContain('.parameter set :appId "com.example.o\'hara"');
    expect(executor.calls[1]?.args).toContain('.parameter set :service0 "service\\\"quoted"');
  });

  test("supports legacy TCC schemas that expose allowed instead of auth_value", async () => {
    const executor = new FakeSqliteExecutor();
    executor.onExecute = async () =>
      executor.calls.at(-1)?.args.at(-1) === "pragma table_info(access);"
        ? result(JSON.stringify([{ name: "service" }, { name: "client" }, { name: "allowed" }]))
        : result(
            JSON.stringify([
              { service: "kTCCServiceCamera", client: "com.example.app", allowed: 1 },
            ]),
          );
    const client = new SimulatorTccSqliteClient({
      executor,
      fileSystem: new FakeTccFileSystem(),
      homeDirectory: "/Users/tester",
    });

    await expect(client.readPermissions(DEVICE_ID, "com.example.app")).resolves.toEqual([
      { service: "kTCCServiceCamera", client: "com.example.app", allowed: 1 },
    ]);
    expect(executor.calls[1]?.args.at(-1)).toContain("select service, client, allowed");
  });

  test("reports unavailable or unreadable TCC databases with device context", async () => {
    const fileSystem = new FakeTccFileSystem();
    fileSystem.error = Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
    const client = new SimulatorTccSqliteClient({
      executor: new FakeSqliteExecutor(),
      fileSystem,
      homeDirectory: "/Users/tester",
    });

    await expect(client.readPermissions(DEVICE_ID, "com.example.app")).rejects.toThrow(
      `Simulator TCC database is unavailable for ${DEVICE_ID}`,
    );
  });

  test("rejects a non-simulator UDID before resolving a host path", async () => {
    const fileSystem = new FakeTccFileSystem();
    const client = new SimulatorTccSqliteClient({
      executor: new FakeSqliteExecutor(),
      fileSystem,
      homeDirectory: "/Users/tester",
    });

    await expect(client.readPermissions("../../other-device", "com.example.app")).rejects.toThrow(
      "requires a simulator UDID",
    );
    expect(fileSystem.paths).toEqual([]);
  });

  test("classifies an unavailable sqlite3 binary and a malformed TCC database", async () => {
    const executor = new FakeSqliteExecutor();
    const client = new SimulatorTccSqliteClient({
      executor,
      fileSystem: new FakeTccFileSystem(),
      homeDirectory: "/Users/tester",
    });
    executor.error = Object.assign(new Error("spawn sqlite3 ENOENT"), { code: "ENOENT" });

    await expect(client.readPermissions(DEVICE_ID, "com.example.app")).rejects.toThrow(
      "sqlite3 is unavailable",
    );

    executor.error = new Error("file is not a database");
    await expect(client.readPermissions(DEVICE_ID, "com.example.app")).rejects.toThrow(
      `Simulator TCC database is malformed for ${DEVICE_ID}`,
    );
  });

  test("rejects incompatible schemas and malformed sqlite JSON", async () => {
    const executor = new FakeSqliteExecutor();
    executor.response = result(JSON.stringify([{ name: "client" }]));
    const client = new SimulatorTccSqliteClient({
      executor,
      fileSystem: new FakeTccFileSystem(),
      homeDirectory: "/Users/tester",
    });

    await expect(client.readPermissions(DEVICE_ID, "com.example.app")).rejects.toThrow(
      "missing required access columns: service",
    );

    executor.response = result("not json");
    await expect(client.readPermissions(DEVICE_ID, "com.example.app")).rejects.toThrow(
      "sqlite3 returned malformed JSON",
    );
  });

  test("aborts the argv execution when the owned timeout elapses", async () => {
    const executor = new FakeSqliteExecutor();
    const timer = new FakeTimer();
    let capturedSignal: AbortSignal | undefined;
    executor.onExecute = async (options) =>
      new Promise<ExecResult>((_resolve, reject) => {
        capturedSignal = options?.signal;
        capturedSignal?.addEventListener(
          "abort",
          () => reject(new Error("The operation was aborted")),
          { once: true },
        );
      });
    const client = new SimulatorTccSqliteClient({
      executor,
      fileSystem: new FakeTccFileSystem(),
      homeDirectory: "/Users/tester",
      timer,
      timeoutMs: 123,
    });

    const pending = client.readPermissions(DEVICE_ID, "com.example.app");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    timer.advanceTime(123);

    await expect(pending).rejects.toThrow(
      "Timed out after 123ms while reading simulator TCC database",
    );
    expect(capturedSignal?.aborted).toBe(true);
  });
});
