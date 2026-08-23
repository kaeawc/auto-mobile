import { describe, expect, test } from "bun:test";
import { GrantIosSimulatorPermissions } from "../../../src/features/action/GrantIosSimulatorPermissions";
import {
  IosSimulatorPermissions,
  SqliteTccPermissionReader,
  type SqliteCommandExecutor,
  type TccPermissionReader,
} from "../../../src/features/action/IosSimulatorPermissions";
import type { BootedDevice } from "../../../src/models";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";

const simulatorDevice: BootedDevice = {
  name: "iPhone 16",
  platform: "ios",
  deviceId: "12345678-1234-1234-1234-123456789ABC",
};

class FakeSqliteCommandExecutor implements SqliteCommandExecutor {
  readonly calls: Array<{ command: string; args: string[] }> = [];

  async execFile(command: string, args: string[]): Promise<{ stdout: string }> {
    this.calls.push({ command, args });
    return {
      stdout:
        args.at(-1) === "pragma table_info(access);"
          ? JSON.stringify([{ name: "service" }, { name: "client" }])
          : "[]",
    };
  }
}

describe("GrantIosSimulatorPermissions", () => {
  test("grants each permission with simctl privacy", async () => {
    const simctl = new FakeSimCtlClient();
    const action = new GrantIosSimulatorPermissions(simulatorDevice, simctl);

    const result = await action.execute("com.example.app", ["camera", "microphone"]);

    expect(result.success).toBe(true);
    expect(result.grantedCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([
      {
        args: [
          "privacy",
          "12345678-1234-1234-1234-123456789ABC",
          "grant",
          "camera",
          "com.example.app",
        ],
        timeoutMs: undefined,
      },
      {
        args: [
          "privacy",
          "12345678-1234-1234-1234-123456789ABC",
          "grant",
          "microphone",
          "com.example.app",
        ],
        timeoutMs: undefined,
      },
    ]);
  });

  test("returns per-permission failures without aborting the batch", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsError(
      ["privacy", "12345678-1234-1234-1234-123456789ABC", "grant", "photos", "com.example.app"],
      new Error("unsupported service"),
    );
    const action = new GrantIosSimulatorPermissions(simulatorDevice, simctl);

    const result = await action.execute("com.example.app", ["camera", "photos"]);

    expect(result.success).toBe(false);
    expect(result.grantedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.results).toEqual([
      {
        permission: "camera",
        success: true,
        stdout: "",
        stderr: "",
      },
      {
        permission: "photos",
        success: false,
        error: "unsupported service",
      },
    ]);
  });

  test("rejects physical iOS devices", async () => {
    const simctl = new FakeSimCtlClient();
    const action = new GrantIosSimulatorPermissions(
      {
        name: "Jason's iPhone",
        platform: "ios",
        deviceId: "00008110-0012345678901234",
      },
      simctl,
    );

    const result = await action.execute("com.example.app", ["camera"]);

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "iOS permission changes via simctl privacy are only supported on simulators",
    );
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
  });

  test("rejects non-iOS devices", async () => {
    const simctl = new FakeSimCtlClient();
    const action = new GrantIosSimulatorPermissions(
      {
        name: "Pixel",
        platform: "android",
        deviceId: "emulator-5554",
      },
      simctl,
    );

    const result = await action.execute("com.example.app", ["camera"]);

    expect(result.success).toBe(false);
    expect(result.error).toBe("iOS simulator permissions are only supported on iOS simulators");
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
  });
});

describe("IosSimulatorPermissions", () => {
  test("revokes and resets permissions with simctl privacy", async () => {
    const simctl = new FakeSimCtlClient();
    const action = new IosSimulatorPermissions(simulatorDevice, simctl);

    const revoke = await action.setPermissions("revoke", "com.example.app", ["camera"]);
    const reset = await action.setPermissions("reset", "com.example.app", ["microphone"]);

    expect(revoke.success).toBe(true);
    expect(revoke.changedCount).toBe(1);
    expect(reset.success).toBe(true);
    expect(reset.changedCount).toBe(1);
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([
      {
        args: [
          "privacy",
          "12345678-1234-1234-1234-123456789ABC",
          "revoke",
          "camera",
          "com.example.app",
        ],
        timeoutMs: undefined,
      },
      {
        args: [
          "privacy",
          "12345678-1234-1234-1234-123456789ABC",
          "reset",
          "microphone",
          "com.example.app",
        ],
        timeoutMs: undefined,
      },
    ]);
  });

  test("queries TCC permission state and reports unknown reset rows", async () => {
    const tccReader: TccPermissionReader = {
      readPermissions: async () => [
        {
          service: "kTCCServiceCamera",
          client: "com.example.app",
          auth_value: 2,
          allowed: null,
          prompt_count: null,
        },
      ],
    };
    const action = new IosSimulatorPermissions(simulatorDevice, new FakeSimCtlClient(), tccReader);

    const result = await action.getPermissions("com.example.app", ["camera", "microphone"]);

    expect(result).toEqual({
      success: true,
      appId: "com.example.app",
      deviceId: "12345678-1234-1234-1234-123456789ABC",
      platform: "ios",
      permissions: [
        {
          permission: "camera",
          service: "kTCCServiceCamera",
          state: "granted",
          authValue: 2,
          raw: {
            service: "kTCCServiceCamera",
            client: "com.example.app",
            auth_value: 2,
            allowed: null,
            prompt_count: null,
          },
        },
        {
          permission: "microphone",
          service: "kTCCServiceMicrophone",
          state: "unknown",
        },
      ],
    });
  });

  test("keeps the legacy injected sqlite reader constructor available", async () => {
    const sqlite = new FakeSqliteCommandExecutor();
    const reader = new SqliteTccPermissionReader(sqlite, "/Users/tester");

    await expect(
      reader.readPermissions(simulatorDevice.deviceId, "com.example.app"),
    ).resolves.toEqual([]);
    expect(sqlite.calls.map((call) => call.command)).toEqual(["sqlite3", "sqlite3"]);
  });

  // Issue #4169 item 14: a bundle id containing a single quote (or double quote /
  // backslash) must not be able to break out of, or inject into, the TCC query.
  // The value is carried as a BOUND `.parameter set :appId` value and the WHERE
  // clause references `:appId`, so the raw id never lands in the SQL string.
  describe("SqliteTccPermissionReader binds the bundle id safely", () => {
    // [name, appId, expected bound .parameter set value including its wrapping quotes]
    const bindCases: Array<[string, string, string]> = [
      ["plain id", "com.example.app", '"com.example.app"'],
      [
        "single-quote injection attempt",
        "com.evil'); drop table access;--",
        '"com.evil\'); drop table access;--"',
      ],
      ["double-quote and backslash are escaped", 'com.a"b\\c', '"com.a\\"b\\\\c"'],
    ];

    test.each(bindCases)(
      "binds :appId for %s instead of interpolating it",
      async (_name, appId, expectedParameterValue) => {
        const sqlite = new FakeSqliteCommandExecutor();
        const reader = new SqliteTccPermissionReader(sqlite, "/Users/tester");

        await reader.readPermissions(simulatorDevice.deviceId, appId, ["camera"]);

        // The SELECT is the second sqlite3 invocation (the first reads pragma table_info).
        const selectCall = sqlite.calls[1];
        const setAppId = selectCall.args.find((arg) => arg.startsWith(".parameter set :appId"));
        expect(setAppId).toBe(`.parameter set :appId ${expectedParameterValue}`);

        // The query text references the bound parameter and never the raw id.
        const query = selectCall.args.at(-1) ?? "";
        expect(query).toContain("where client = :appId");
        expect(query).not.toContain(appId);
      },
    );
  });
});
