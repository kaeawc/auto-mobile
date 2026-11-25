import { describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import path from "node:path";
import { IosDisposableAppInstaller } from "../../../../../src/features/prototype/disposableApp/ios/IosDisposableAppInstaller";
import {
  disposableAppId,
  DISPOSABLE_APP_ID_PREFIX,
} from "../../../../../src/features/prototype/disposableApp/disposableAppId";
import type { PrototypePermissionName } from "../../../../../src/features/prototype/prototypePermissionMap";
import { ActionableError } from "../../../../../src/models/ActionableError";
import { createExecResult } from "../../../../../src/utils/execResult";
import type { IosInstalledAppRecord } from "../../../../../src/utils/ios-cmdline-tools/iosInstalledApp";
import type {
  TccPermissionReader,
  TccPermissionRow,
} from "../../../../../src/utils/ios-cmdline-tools/SimulatorTccSqliteClient";
import {
  FakePrototypeDataWriter,
  FakePrototypeSimctl,
  InstallerOperationRecorder,
} from "../../../../fakes/FakePrototypeInstaller";

const simulator = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const iphone = "00008030-001C195E0A91802E";
const appId = disposableAppId("ios", "feedly");
const bundle = path.join(path.resolve(path.sep), "fixture", "PrototypeViewer.app");
const container = path.join(path.resolve(path.sep), "fixture", "container");
const spec = { id: "feedly", root: { type: "column" } };
const noGrants = { declared: [], granted: [], denied: [] };

/** The simulator's TCC rows for `appId`, keyed by simctl service; a missing row is notDetermined. */
class FakeTccReader implements TccPermissionReader {
  readonly rows = new Map<string, TccPermissionRow>();
  readonly reads: string[][] = [];

  constructor(private readonly operations: InstallerOperationRecorder) {}

  set(service: string, authValue: number): void {
    this.rows.set(service, { service, client: appId, auth_value: authValue });
  }

  async readPermissions(
    _deviceId: string,
    _appId: string,
    permissions: string[] = [],
  ): Promise<TccPermissionRow[]> {
    this.operations.record("tcc");
    this.reads.push(permissions);
    return permissions.flatMap((service) => {
      const row = this.rows.get(service);
      return row ? [row] : [];
    });
  }
}

function harness() {
  const operations = new InstallerOperationRecorder();
  const simctl = new FakePrototypeSimctl(operations);
  simctl.containerPath = container;
  const data = new FakePrototypeDataWriter(operations);
  const files = {
    readFile: mock(async (_file: string) => {
      operations.record("read");
      return JSON.stringify(spec);
    }),
  };
  const commands = {
    executeCommandArgs: mock(async (args: string[]) => {
      operations.record(args[0] ?? "");
      return createExecResult("", "");
    }),
    listAppsOrThrow: mock(async (_deviceId?: string): Promise<IosInstalledAppRecord[]> => {
      operations.record("list");
      return [
        { bundleId: "com.example.other", Path: path.join(bundle, "Other.app") },
        { bundleId: appId, Path: bundle, DataContainer: container },
      ];
    }),
  };
  const clearStorage = mock(async (deviceId: string, packageName: string) => {
    operations.record("clear");
    return { success: true, deviceId, packageName };
  });
  const tcc = new FakeTccReader(operations);
  return {
    installer: new IosDisposableAppInstaller({ simctl, files, commands, data, clearStorage, tcc }),
    operations,
    tcc,
    simctl,
    commands,
    files,
    data,
    clearStorage,
  };
}

function operationsFor(installer: IosDisposableAppInstaller, deviceId: string, idOrPrefix: string) {
  return [
    installer.install(deviceId, idOrPrefix, bundle),
    installer.seedStorage(deviceId, idOrPrefix, bundle),
    installer.resetStorage(deviceId, idOrPrefix),
    installer.applyPermissions(deviceId, idOrPrefix, noGrants),
    installer.uninstall(deviceId, idOrPrefix),
    installer.installedIds(deviceId, idOrPrefix),
    installer.inspect(deviceId, idOrPrefix),
  ];
}

describe("IosDisposableAppInstaller", () => {
  test("installs in place after validating the bundled spec, leaving storage to seedStorage", async () => {
    const { installer, operations, simctl, data, files, clearStorage } = harness();
    await installer.install(simulator, appId, bundle);
    await installer.install(simulator, appId, bundle);
    expect(files.readFile).toHaveBeenCalledWith(path.join(bundle, "prototype.json"));
    expect(simctl.installed).toEqual([
      { udid: simulator, appPath: bundle },
      { udid: simulator, appPath: bundle },
    ]);
    expect(data.writes).toEqual([]);
    expect(operations.events).toEqual(["read", "install", "read", "install"]);
    expect(clearStorage).not.toHaveBeenCalled();
  });

  test("does not install a bundle whose spec does not parse", async () => {
    const { installer, simctl, files } = harness();
    files.readFile.mockResolvedValueOnce("{not json");
    await expect(installer.install(simulator, appId, bundle)).rejects.toThrow(
      `Cannot install iOS disposable app ${appId}`,
    );
    expect(simctl.installed).toEqual([]);
  });

  test("seeds the saved Viewer layout from the bundle into the data container", async () => {
    const { installer, operations, simctl, data, files } = harness();
    await installer.seedStorage(simulator, appId, bundle);
    expect(files.readFile).toHaveBeenCalledWith(path.join(bundle, "prototype.json"));
    expect(simctl.containers).toEqual([appId]);
    expect(data.writes).toEqual([{ containerPath: container, spec }]);
    expect(operations.events).toEqual(["read", "container", "data"]);
  });

  test("reports a seeding failure as a structured error", async () => {
    const { installer, data } = harness();
    data.write = async () => {
      throw new Error("disk full");
    };
    const failure = installer.seedStorage(simulator, appId, bundle);
    await expect(failure).rejects.toBeInstanceOf(ActionableError);
    await expect(failure).rejects.toThrow(
      `Cannot seed storage for iOS disposable app ${appId}: disk full`,
    );
  });

  test("wipes the data container and restores the spec from the installed bundle", async () => {
    const { installer, operations, commands, files, data, clearStorage } = harness();
    await installer.resetStorage(simulator, appId);
    expect(commands.listAppsOrThrow).toHaveBeenCalledWith(simulator);
    expect(files.readFile).toHaveBeenCalledWith(path.join(bundle, "prototype.json"));
    expect(clearStorage).toHaveBeenCalledWith(simulator, appId);
    expect(data.writes).toEqual([{ containerPath: container, spec }]);
    expect(operations.events).toEqual(["list", "read", "clear", "container", "data"]);
  });

  test.each([undefined, "relative/Viewer.app"])(
    "leaves app data intact when the listed bundle path is %s",
    async (bundlePath) => {
      const { installer, commands, files, clearStorage, data } = harness();
      commands.listAppsOrThrow.mockResolvedValueOnce([
        { bundleId: appId, Path: bundlePath, DataContainer: container },
      ]);
      await expect(installer.resetStorage(simulator, appId)).rejects.toThrow(
        `Simulator did not return a bundle path for ${appId}.`,
      );
      expect(files.readFile).not.toHaveBeenCalled();
      expect(clearStorage).not.toHaveBeenCalled();
      expect(data.writes).toEqual([]);
    },
  );

  test("guards every operation before simctl or filesystem access", async () => {
    const { installer, operations } = harness();
    const results = await Promise.allSettled(
      operationsFor(installer, iphone, "com.example.foreign"),
    );
    for (const result of results) {
      expect(result).toEqual({
        status: "rejected",
        reason: expect.objectContaining({
          message: expect.stringContaining("not a disposable prototype app"),
        }),
      });
    }
    expect(operations.events).toEqual([]);
  });

  test("refuses every operation on a physical iPhone", async () => {
    const { installer, operations } = harness();
    const results = await Promise.allSettled(operationsFor(installer, iphone, appId));
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(ActionableError);
        expect(result.reason).toHaveProperty("message", expect.stringContaining("Use ProtoViewer"));
      }
    }
    expect(operations.events).toEqual([]);
  });

  test("maps canonical grants and revokes, then reads each declared name back from TCC", async () => {
    const { installer, commands, tcc } = harness();
    const granted: PrototypePermissionName[] = [
      "microphone",
      "location",
      "locationBackground",
      "photos",
      "photosAdd",
      "contacts",
      "calendar",
      "motion",
    ];
    const services = [
      "microphone",
      "location",
      "location-always",
      "photos",
      "photos-add",
      "contacts",
      "calendar",
      "motion",
    ];
    services.forEach((service) => tcc.set(service, 2));
    tcc.set("camera", 0);
    const results = await installer.applyPermissions(simulator, appId, {
      declared: ["camera", ...granted],
      granted,
      denied: ["camera"],
    });
    expect(commands.executeCommandArgs.mock.calls.map(([args]) => args)).toEqual([
      ["privacy", simulator, "revoke", "camera", appId],
      ...services.map((service) => ["privacy", simulator, "grant", service, appId]),
    ]);
    expect(tcc.reads).toEqual([["camera"], ...services.map((service) => [service])]);
    expect(results).toEqual([
      { name: "camera", state: "denied", verified: true },
      ...granted.map((name) => ({ name, state: "granted" as const, verified: true })),
    ]);
  });

  test("reports a name without a simctl service as notGrantableOnSimulator, never writing it", async () => {
    const { installer, commands } = harness();
    const results = await installer.applyPermissions(simulator, appId, {
      declared: ["bluetooth", "nearbyWifi", "notifications", "speech"],
      granted: ["bluetooth", "nearbyWifi", "notifications"],
      denied: ["speech"],
    });
    const unsupported: PrototypePermissionName[] = [
      "bluetooth",
      "nearbyWifi",
      "notifications",
      "speech",
    ];
    expect(results).toEqual(
      unsupported.map((name) => ({
        name,
        state: "notDetermined" as const,
        verified: false,
        reason: "notGrantableOnSimulator" as const,
      })),
    );
    expect(commands.executeCommandArgs).not.toHaveBeenCalled();
  });

  test("prompt mode writes nothing and reads each declared name notDetermined", async () => {
    const { installer, commands, tcc } = harness();
    const results = await installer.applyPermissions(simulator, appId, {
      declared: ["camera", "notifications"],
      granted: [],
      denied: [],
    });
    expect(results).toEqual([
      { name: "camera", state: "notDetermined", verified: true },
      { name: "notifications", state: "notDetermined", verified: true },
    ]);
    expect(commands.executeCommandArgs).not.toHaveBeenCalled();
    expect(tcc.reads).toEqual([["camera"]]);
  });

  test("a simctl privacy failure stops before any read", async () => {
    const { installer, commands, tcc } = harness();
    commands.executeCommandArgs.mockRejectedValueOnce(new Error("simctl privacy exited 1"));
    await expect(
      installer.applyPermissions(simulator, appId, {
        declared: ["camera"],
        granted: ["camera"],
        denied: [],
      }),
    ).rejects.toThrow("simctl privacy exited 1");
    expect(tcc.reads).toEqual([]);
  });

  test("refuses a declared name outside the prototype permission names before any write", async () => {
    const { installer, commands } = harness();
    await expect(
      installer.applyPermissions(simulator, appId, {
        declared: ["camera", "constructor"],
        granted: ["camera"],
        denied: [],
      }),
    ).rejects.toThrow(/constructor is not a prototype permission name/);
    expect(commands.executeCommandArgs).not.toHaveBeenCalled();
  });

  test("lists only disposable IDs, reports the ad-hoc digest and uninstalls by bundle ID", async () => {
    const { installer, simctl } = harness();
    const another = disposableAppId("ios", "weather");
    simctl.apps = [
      { bundleId: appId },
      { bundleId: another },
      { bundleId: "com.example.foreign" },
      { bundleId: DISPOSABLE_APP_ID_PREFIX },
    ];
    expect(await installer.installedIds(simulator, DISPOSABLE_APP_ID_PREFIX)).toEqual([
      appId,
      another,
    ]);
    expect(await installer.installedIds(simulator, `${DISPOSABLE_APP_ID_PREFIX}feed`)).toEqual([
      appId,
    ]);
    expect(await installer.inspect(simulator, appId)).toEqual({
      installed: true,
      signer: createHash("sha256").update("adhoc").digest("hex"),
    });
    expect(await installer.inspect(simulator, disposableAppId("ios", "absent"))).toEqual({
      installed: false,
    });
    await installer.uninstall(simulator, appId);
    expect(simctl.deleted).toEqual([appId]);
  });
});
