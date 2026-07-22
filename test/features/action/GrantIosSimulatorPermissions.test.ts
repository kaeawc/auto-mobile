import { describe, expect, test } from "bun:test";
import { join } from "path";
import { GrantIosSimulatorPermissions } from "../../../src/features/action/GrantIosSimulatorPermissions";
import {
  IosSimulatorPermissions,
  SqliteTccPermissionReader,
  type SqliteCommandExecutor,
  type TccPermissionReader
} from "../../../src/features/action/IosSimulatorPermissions";
import type { BootedDevice } from "../../../src/models";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";

const simulatorDevice: BootedDevice = {
  name: "iPhone 16",
  platform: "ios",
  deviceId: "12345678-1234-1234-1234-123456789ABC"
};

class FakeSqliteCommandExecutor implements SqliteCommandExecutor {
  readonly calls: Array<{ command: string; args: string[] }> = [];

  async execFile(command: string, args: string[]): Promise<{ stdout: string }> {
    this.calls.push({ command, args });

    const sql = args.at(-1);
    if (sql === "pragma table_info(access);") {
      return {
        stdout: JSON.stringify([
          { name: "service" },
          { name: "client" },
          { name: "auth_value" },
          { name: "prompt_count" }
        ])
      };
    }

    return {
      stdout: JSON.stringify([
        {
          service: "kTCCServiceCamera",
          client: "com.example.app",
          auth_value: 2,
          prompt_count: 1
        }
      ])
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
        args: ["privacy", "12345678-1234-1234-1234-123456789ABC", "grant", "camera", "com.example.app"],
        timeoutMs: undefined
      },
      {
        args: ["privacy", "12345678-1234-1234-1234-123456789ABC", "grant", "microphone", "com.example.app"],
        timeoutMs: undefined
      }
    ]);
  });

  test("returns per-permission failures without aborting the batch", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsError(
      ["privacy", "12345678-1234-1234-1234-123456789ABC", "grant", "photos", "com.example.app"],
      new Error("unsupported service")
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
        stderr: ""
      },
      {
        permission: "photos",
        success: false,
        error: "unsupported service"
      }
    ]);
  });

  test("rejects physical iOS devices", async () => {
    const simctl = new FakeSimCtlClient();
    const action = new GrantIosSimulatorPermissions({
      name: "Jason's iPhone",
      platform: "ios",
      deviceId: "00008110-0012345678901234"
    }, simctl);

    const result = await action.execute("com.example.app", ["camera"]);

    expect(result.success).toBe(false);
    expect(result.error).toBe("iOS permission changes via simctl privacy are only supported on simulators");
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
  });

  test("rejects non-iOS devices", async () => {
    const simctl = new FakeSimCtlClient();
    const action = new GrantIosSimulatorPermissions({
      name: "Pixel",
      platform: "android",
      deviceId: "emulator-5554"
    }, simctl);

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
        args: ["privacy", "12345678-1234-1234-1234-123456789ABC", "revoke", "camera", "com.example.app"],
        timeoutMs: undefined
      },
      {
        args: ["privacy", "12345678-1234-1234-1234-123456789ABC", "reset", "microphone", "com.example.app"],
        timeoutMs: undefined
      }
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
          prompt_count: null
        }
      ]
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
            prompt_count: null
          }
        },
        {
          permission: "microphone",
          service: "kTCCServiceMicrophone",
          state: "unknown"
        }
      ]
    });
  });

  test("reads TCC rows with sqlite json mode flag and SQL-only statements", async () => {
    const sqlite = new FakeSqliteCommandExecutor();
    const reader = new SqliteTccPermissionReader(sqlite, "/Users/tester");
    const expectedTccPath = join(
      "/Users/tester",
      "Library",
      "Developer",
      "CoreSimulator",
      "Devices",
      "12345678-1234-1234-1234-123456789ABC",
      "data",
      "Library",
      "TCC",
      "TCC.db"
    );

    const rows = await reader.readPermissions(
      "12345678-1234-1234-1234-123456789ABC",
      "com.example.app",
      ["camera"]
    );

    expect(rows).toEqual([
      {
        service: "kTCCServiceCamera",
        client: "com.example.app",
        auth_value: 2,
        prompt_count: 1
      }
    ]);
    expect(sqlite.calls).toEqual([
      {
        command: "sqlite3",
        args: [
          "-json",
          expectedTccPath,
          "pragma table_info(access);"
        ]
      },
      {
        command: "sqlite3",
        args: [
          "-json",
          expectedTccPath,
          [
            "select service, client, auth_value, prompt_count",
            "from access",
            "where client = 'com.example.app' and service in ('kTCCServiceCamera');"
          ].join("\n")
        ]
      }
    ]);
  });
});
