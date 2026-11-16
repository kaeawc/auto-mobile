import { describe, expect, test } from "bun:test";
import type { ExecResult } from "../../../src/models";
import type { IosPrivacyOperation } from "../../../src/utils/ios-cmdline-tools/IosPermissionsBackend";
import type { TccPermissionRow } from "../../../src/utils/ios-cmdline-tools/SimulatorTccSqliteClient";
import { createExecResult } from "../../../src/utils/execResult";
import {
  AndroidPrototypePermissionBackend,
  IosSimulatorPrototypePermissionBackend,
} from "../../../src/features/prototype/prototypePermissionBackends";
import { applyPrototypePermissions } from "../../../src/features/prototype/prototypePermissionGrants";
import { PROTOTYPE_PERMISSION_MAP } from "../../../src/features/prototype/prototypePermissionMap";

const PACKAGE = "dev.jasonpearson.automobile.app.feedly-1a2b3c4d";

/** Keeps runtime permission state the way `pm` does and renders it as `dumpsys package`. */
class FakePm {
  readonly commands: string[] = [];
  private readonly granted = new Map<string, boolean>();
  private readonly flags = new Map<string, Set<string>>();

  constructor(
    private readonly requested: readonly string[],
    private readonly failOn?: string,
  ) {}

  async executeCommand(command: string): Promise<ExecResult> {
    this.commands.push(command);
    if (this.failOn !== undefined && command.includes(this.failOn)) {
      return createExecResult("", "Exception occurred while executing 'grant':");
    }
    if (command.startsWith("shell dumpsys package")) {
      return createExecResult(this.dump(), "");
    }
    const match = command.match(/^shell pm (\S+) --user 0 '[^']+' '([^']+)'(.*)$/);
    if (match) {
      this.apply(match[1], match[2], match[3].trim().split(" ").filter(Boolean));
    }
    return createExecResult("", "");
  }

  private apply(verb: string, permission: string, flags: string[]): void {
    const current = this.flags.get(permission) ?? new Set<string>();
    this.flags.set(permission, current);
    if (verb === "grant" || verb === "revoke") {
      this.granted.set(permission, verb === "grant");
    }
    const names = flags.map((flag) => flag.toUpperCase().replace("-", "_"));
    if (verb === "set-permission-flags") {
      names.forEach((name) => current.add(name));
    }
    if (verb === "clear-permission-flags") {
      names.forEach((name) => current.delete(name));
    }
  }

  private dump(): string {
    const runtime = this.requested.map((permission) => {
      const flags = [...(this.flags.get(permission) ?? [])].join("|");
      return `        ${permission}: granted=${this.granted.get(permission) ?? false}, flags=[ ${flags} ]`;
    });
    return [
      `  Package [${PACKAGE}] (abc123):`,
      "    requested permissions:",
      ...this.requested.map((permission) => `      ${permission}`),
      "    User 0: ceDataInode=1 installed=true",
      "      runtime permissions:",
      ...runtime,
    ].join("\n");
  }
}

function androidBackend(pm: FakePm, apiLevel = 34): AndroidPrototypePermissionBackend {
  return new AndroidPrototypePermissionBackend(pm, { packageName: PACKAGE, userId: 0, apiLevel });
}

describe("AndroidPrototypePermissionBackend", () => {
  test("a deny revokes with user-fixed, so it reads blocked", async () => {
    const pm = new FakePm(["android.permission.CAMERA", "android.permission.RECORD_AUDIO"]);
    const results = await applyPrototypePermissions(
      ["camera", "microphone"],
      { grant: ["camera"], deny: ["microphone"] },
      androidBackend(pm),
    );
    expect(results).toEqual([
      { name: "camera", state: "granted", verified: true },
      { name: "microphone", state: "blocked", verified: true },
    ]);
    expect(pm.commands).toContain(
      `shell pm set-permission-flags --user 0 '${PACKAGE}' 'android.permission.RECORD_AUDIO' user-set user-fixed`,
    );
  });

  test("a grant after a deny clears user-fixed", async () => {
    const pm = new FakePm(["android.permission.CAMERA"]);
    const backend = androidBackend(pm);
    await backend.deny("camera", PROTOTYPE_PERMISSION_MAP.camera);
    await backend.grant("camera", PROTOTYPE_PERMISSION_MAP.camera);
    expect(await backend.read("camera", PROTOTYPE_PERMISSION_MAP.camera)).toBe("granted");
    await pm.executeCommand(`shell pm revoke --user 0 '${PACKAGE}' 'android.permission.CAMERA'`);
    expect(await backend.read("camera", PROTOTYPE_PERMISSION_MAP.camera)).toBe("notDetermined");
  });

  test("prompt leaves every declared name notDetermined", async () => {
    const pm = new FakePm(["android.permission.CAMERA"]);
    const results = await applyPrototypePermissions(["camera"], "prompt", androidBackend(pm));
    expect(results).toEqual([{ name: "camera", state: "notDetermined", verified: true }]);
    expect(pm.commands.every((command) => command.startsWith("shell dumpsys"))).toBe(true);
  });

  test("a partial location grant reads limited and an undeclared name reads unavailable", async () => {
    const pm = new FakePm([
      "android.permission.ACCESS_FINE_LOCATION",
      "android.permission.ACCESS_COARSE_LOCATION",
    ]);
    await pm.executeCommand(
      `shell pm grant --user 0 '${PACKAGE}' 'android.permission.ACCESS_COARSE_LOCATION'`,
    );
    const backend = androidBackend(pm);
    expect(await backend.read("location", PROTOTYPE_PERMISSION_MAP.location)).toBe("limited");
    expect(await backend.read("camera", PROTOTYPE_PERMISSION_MAP.camera)).toBe("unavailable");
  });

  test("photosAdd has no runtime permission and reads granted without a shell call", async () => {
    const pm = new FakePm([]);
    expect(await androidBackend(pm).read("photosAdd", PROTOTYPE_PERMISSION_MAP.photosAdd)).toBe(
      "granted",
    );
    expect(pm.commands).toEqual([]);
  });

  test("notifications use the appop before API 33", async () => {
    const pm = new FakePm([]);
    await androidBackend(pm, 32).deny("notifications", PROTOTYPE_PERMISSION_MAP.notifications);
    expect(pm.commands).toEqual([`shell cmd appops set '${PACKAGE}' POST_NOTIFICATION deny`]);
  });

  test("a shell failure throws so the show does not launch half-applied", async () => {
    const pm = new FakePm(["android.permission.CAMERA"], "pm grant");
    await expect(
      applyPrototypePermissions(["camera"], "grantDeclared", androidBackend(pm)),
    ).rejects.toThrow("pm grant");
  });
});

class FakePrivacy {
  readonly operations: IosPrivacyOperation[] = [];
  readonly rows = new Map<string, TccPermissionRow>();

  async setPrivacy(operation: IosPrivacyOperation): Promise<ExecResult> {
    this.operations.push(operation);
    this.rows.set(operation.permission, {
      service: operation.permission,
      client: operation.appId,
      auth_value: operation.action === "grant" ? 2 : 0,
    });
    return createExecResult("", "");
  }

  async readPermissions(
    _deviceId: string,
    _appId: string,
    permissions?: string[],
  ): Promise<TccPermissionRow[]> {
    return (permissions ?? []).flatMap((permission) => {
      const row = this.rows.get(permission);
      return row ? [row] : [];
    });
  }
}

describe("IosSimulatorPrototypePermissionBackend", () => {
  const options = { deviceId: "SIM-1", bundleId: "dev.jasonpearson.automobile.proto.feedly" };

  test("grant and revoke go through simctl privacy and read back from TCC", async () => {
    const privacy = new FakePrivacy();
    const backend = new IosSimulatorPrototypePermissionBackend(privacy, privacy, options);
    const results = await applyPrototypePermissions(
      ["camera", "locationBackground", "contacts"],
      { grant: ["camera"], deny: ["locationBackground"] },
      backend,
    );
    expect(results).toEqual([
      { name: "camera", state: "granted", verified: true },
      { name: "locationBackground", state: "denied", verified: true },
      { name: "contacts", state: "notDetermined", verified: true },
    ]);
    expect(privacy.operations).toEqual([
      { action: "grant", permission: "camera", appId: options.bundleId },
      { action: "revoke", permission: "location-always", appId: options.bundleId },
    ]);
  });

  test("notifications are reported notGrantableOnSimulator without a privacy call", async () => {
    const privacy = new FakePrivacy();
    const backend = new IosSimulatorPrototypePermissionBackend(privacy, privacy, options);
    const results = await applyPrototypePermissions(["notifications"], "grantDeclared", backend);
    expect(results).toEqual([
      {
        name: "notifications",
        state: "notDetermined",
        verified: false,
        reason: "notGrantableOnSimulator",
      },
    ]);
    expect(privacy.operations).toEqual([]);
  });

  test("a limited TCC row reads limited", async () => {
    const privacy = new FakePrivacy();
    privacy.rows.set("photos", { service: "photos", client: options.bundleId, auth_value: 3 });
    const backend = new IosSimulatorPrototypePermissionBackend(privacy, privacy, options);
    expect(await backend.read("photos", PROTOTYPE_PERMISSION_MAP.photos)).toBe("limited");
  });
});
