import { describe, expect, test } from "bun:test";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { DeviceConditionController } from "../../../src/features/deviceCondition/DeviceConditionController";
import {
  resolveIosSimulatorConditionInjector,
  type SimctlConditionRunner,
} from "../../../src/features/deviceCondition/iosSimulatorConditionInjectors";
import type {
  TccPermissionReader,
  TccPermissionRow,
} from "../../../src/utils/ios-cmdline-tools/SimulatorTccSqliteClient";

const UDID = "6F2C3A1B-1234-4ABC-9DEF-0123456789AB";
const simulator: BootedDevice = { name: "iPhone 16", platform: "ios", deviceId: UDID };
const physical: BootedDevice = {
  name: "iPhone",
  platform: "ios",
  deviceId: "00008110-001A2B3C4D5E6F70",
};

const ok = (stdout = ""): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (value: string) => stdout.includes(value),
});

class RecordingSimctl implements SimctlConditionRunner {
  readonly calls: string[][] = [];
  failOn?: string;

  executeCommandArgs(args: string[]): Promise<ExecResult> {
    this.calls.push(args);
    if (this.failOn !== undefined && args.includes(this.failOn)) {
      return Promise.resolve({ ...ok(), error: `${this.failOn} refused` });
    }
    return Promise.resolve(ok());
  }
}

/** A TCC store the fake simctl privacy commands also write, keyed by app and service. */
class FakeTccStore implements TccPermissionReader {
  readonly rows = new Map<string, TccPermissionRow>();
  readonly reads: string[] = [];

  set(appId: string, service: string, authValue: number | undefined): void {
    const key = `${appId}|${service}`;
    if (authValue === undefined) {
      this.rows.delete(key);
    } else {
      this.rows.set(key, { service, client: appId, auth_value: authValue });
    }
  }

  readPermissions(_deviceId: string, appId: string): Promise<TccPermissionRow[]> {
    this.reads.push(appId);
    return Promise.resolve([...this.rows.values()].filter((row) => row.client === appId));
  }
}

const TCC_SERVICE: Record<string, string> = {
  camera: "kTCCServiceCamera",
  photos: "kTCCServicePhotos",
  "photos-add": "kTCCServicePhotosAdd",
  microphone: "kTCCServiceMicrophone",
};

function harness(device: BootedDevice = simulator) {
  const simctl = new RecordingSimctl();
  const tcc = new FakeTccStore();
  // The fake simctl privacy verb mutates the fake TCC store like the real one does.
  const runner: SimctlConditionRunner = {
    executeCommandArgs: async (args, timeout, signal) => {
      const result = await simctl.executeCommandArgs(args);
      if (args[0] === "privacy" && !result.error) {
        const [, , action, service, appId] = args;
        const values: Record<string, number | undefined> = {
          grant: 2,
          revoke: 0,
          reset: undefined,
        };
        tcc.set(appId, TCC_SERVICE[service], values[action]);
        // iOS 26.5 captures: revoking Photos also denies PhotosAdd.
        if (service === "photos" && action === "revoke") {
          tcc.set(appId, TCC_SERVICE["photos-add"], 0);
        }
      }
      void timeout;
      void signal;
      return result;
    },
  };
  const privacyBaselines = new Map();
  const controller = new DeviceConditionController((key) =>
    resolveIosSimulatorConditionInjector(device, key, {
      simctlFactory: () => runner,
      privacyReader: tcc,
      privacyBaselines,
    }),
  );
  return { simctl, tcc, controller };
}

describe("statusBar on the iOS Simulator", () => {
  test("overrides the requested fields and reset clears them", async () => {
    const h = harness();
    const result = await h.controller.apply({ statusBar: { time: "9:41", batteryLevel: 100 } });
    expect(result.changes).toEqual([
      { key: "statusBar", status: "applied", detail: "status bar overrides: time, batteryLevel" },
    ]);
    expect(h.simctl.calls).toEqual([
      ["status_bar", UDID, "override", "--time", "9:41", "--batteryLevel", "100"],
    ]);
    expect(result.active).toEqual(["statusBar"]);

    const restore = await h.controller.restore();
    expect(restore).toEqual({ restored: ["statusBar"], failures: [], verifiedClean: true });
    expect(h.simctl.calls.at(-1)).toEqual(["status_bar", UDID, "clear"]);
  });

  test("a failed override is unsupported and owes no reset", async () => {
    const h = harness();
    h.simctl.failOn = "override";
    const result = await h.controller.apply({ statusBar: { operatorName: "Carrier" } });
    expect(result.success).toBe(false);
    expect(result.changes[0]).toMatchObject({ key: "statusBar", status: "unsupported" });
    expect(result.active).toEqual([]);
  });
});

describe("location on the iOS Simulator", () => {
  test("sets the simulated location and unset clears it", async () => {
    const h = harness();
    const applied = await h.controller.apply({ location: { latitude: 37.33, longitude: -122.03 } });
    expect(applied.changes[0]).toMatchObject({ key: "location", status: "applied" });
    expect(h.simctl.calls).toEqual([["location", UDID, "set", "37.33,-122.03"]]);

    const cleared = await h.controller.apply({ location: "unset" });
    expect(cleared.changes).toEqual([{ key: "location", status: "cleared" }]);
    expect(h.simctl.calls.at(-1)).toEqual(["location", UDID, "clear"]);
    expect(cleared.active).toEqual([]);
  });

  test("a failed clear stays owed so release retries it", async () => {
    const h = harness();
    await h.controller.apply({ location: { latitude: 0, longitude: 0 } });
    h.simctl.failOn = "clear";
    const restore = await h.controller.restore();
    expect(restore.verifiedClean).toBe(false);
    expect(restore.failures[0].key).toBe("location");
    expect(h.controller.activeKeys()).toEqual(["location"]);
  });
});

describe("privacy on the iOS Simulator", () => {
  const revokePhotos = {
    privacy: { appId: "com.example.app", service: "photos", action: "revoke" },
  } as const;

  test("reset restores an earlier grant and verifies it from the TCC store", async () => {
    const h = harness();
    h.tcc.set("com.example.app", "kTCCServicePhotos", 2);
    const result = await h.controller.apply(revokePhotos);
    expect(result.changes[0]).toMatchObject({ key: "privacy", status: "applied" });
    expect(h.simctl.calls).toEqual([["privacy", UDID, "revoke", "photos", "com.example.app"]]);

    const restore = await h.controller.restore();
    expect(restore.verifiedClean).toBe(true);
    // The revoke also denied PhotosAdd, which had no decision before, so it is reset too.
    expect(h.simctl.calls.slice(1)).toEqual([
      ["privacy", UDID, "grant", "photos", "com.example.app"],
      ["privacy", UDID, "reset", "photos-add", "com.example.app"],
    ]);
    expect(h.tcc.rows.get("com.example.app|kTCCServicePhotos")?.auth_value).toBe(2);
    expect(h.tcc.rows.has("com.example.app|kTCCServicePhotosAdd")).toBe(false);
  });

  test("a sibling PhotosAdd grant the revoke removed is granted back", async () => {
    const h = harness();
    h.tcc.set("com.example.app", "kTCCServicePhotos", 2);
    h.tcc.set("com.example.app", "kTCCServicePhotosAdd", 2);
    await h.controller.apply(revokePhotos);
    expect(h.tcc.rows.get("com.example.app|kTCCServicePhotosAdd")?.auth_value).toBe(0);

    const restore = await h.controller.restore();
    expect(restore.verifiedClean).toBe(true);
    expect(h.tcc.rows.get("com.example.app|kTCCServicePhotos")?.auth_value).toBe(2);
    expect(h.tcc.rows.get("com.example.app|kTCCServicePhotosAdd")?.auth_value).toBe(2);
  });

  test("a retried older reset cannot reinstate a fixture after the original was restored", async () => {
    const h = harness();
    h.tcc.set("com.example.app", "kTCCServicePhotos", 2);
    h.tcc.set("com.example.app", "kTCCServicePhotosAdd", 2);
    await h.controller.apply(revokePhotos);
    await h.controller.apply({
      privacy: { appId: "com.example.app", service: "photos", action: "grant" },
    });
    // The newest reset fails once; the older one then restores the shared original.
    const read = h.tcc.readPermissions.bind(h.tcc);
    let failNext = true;
    h.tcc.readPermissions = (deviceId, appId) => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("TCC read failed"));
      }
      return read(deviceId, appId);
    };
    const first = await h.controller.restore();
    expect(first.verifiedClean).toBe(false);
    expect(h.tcc.rows.get("com.example.app|kTCCServicePhotosAdd")?.auth_value).toBe(2);

    const callsBefore = h.simctl.calls.length;
    const second = await h.controller.restore();
    expect(second.verifiedClean).toBe(true);
    expect(h.simctl.calls.length).toBe(callsBefore);
    expect(h.tcc.rows.get("com.example.app|kTCCServicePhotos")?.auth_value).toBe(2);
    expect(h.tcc.rows.get("com.example.app|kTCCServicePhotosAdd")?.auth_value).toBe(2);
  });

  test("with no earlier decision, reset returns the service to not yet asked", async () => {
    const h = harness();
    await h.controller.apply({
      privacy: { appId: "com.example.app", service: "microphone", action: "grant" },
    });
    await h.controller.restore();
    expect(h.simctl.calls.at(-1)).toEqual([
      "privacy",
      UDID,
      "reset",
      "microphone",
      "com.example.app",
    ]);
    expect(h.tcc.rows.size).toBe(0);
  });

  test("the decision already in place is unchanged and owes no reset", async () => {
    const h = harness();
    h.tcc.set("com.example.app", "kTCCServicePhotos", 0);
    const result = await h.controller.apply(revokePhotos);
    expect(result.changes[0]).toMatchObject({ key: "privacy", status: "unchanged" });
    expect(h.simctl.calls).toEqual([]);
    expect(result.active).toEqual([]);
  });

  test("a limited decision simctl cannot recreate is refused before any change", async () => {
    const h = harness();
    h.tcc.set("com.example.app", "kTCCServicePhotos", 3);
    const result = await h.controller.apply(revokePhotos);
    expect(result.changes[0]).toMatchObject({ key: "privacy", status: "unsupported" });
    expect(result.changes[0].detail).toContain("cannot be restored");
    expect(h.simctl.calls).toEqual([]);
  });

  test("a restore that does not read back the earlier decision is a failure", async () => {
    const h = harness();
    h.tcc.set("com.example.app", "kTCCServicePhotos", 2);
    await h.controller.apply(revokePhotos);
    // Something else revokes it again behind the reset's back.
    const restoreReader = h.tcc.readPermissions.bind(h.tcc);
    h.tcc.readPermissions = async (deviceId, appId) => {
      h.tcc.set("com.example.app", "kTCCServicePhotos", 0);
      return restoreReader(deviceId, appId);
    };
    const restore = await h.controller.restore();
    expect(restore.verifiedClean).toBe(false);
    expect(restore.failures[0]).toEqual({
      key: "privacy",
      error: "reset ran but the device did not read clean",
    });
  });
});

describe("refusals", () => {
  test("a physical iOS device is refused with a simulator pointer", async () => {
    const h = harness(physical);
    const result = await h.controller.apply({ location: { latitude: 1, longitude: 2 } });
    expect(result.changes[0].detail).toContain("physical iOS device");
    expect(h.simctl.calls).toEqual([]);
  });

  test("keys outside the shared set fall through", () => {
    expect(resolveIosSimulatorConditionInjector(simulator, "rootState")).toBeUndefined();
  });
});
