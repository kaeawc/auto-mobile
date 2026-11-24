import { describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import path from "node:path";
import { IosDisposableAppInstaller } from "../../../../../src/features/prototype/disposableApp/ios/IosDisposableAppInstaller";
import {
  disposableAppId,
  DISPOSABLE_APP_ID_PREFIX,
} from "../../../../../src/features/prototype/disposableApp/disposableAppId";
import { ActionableError } from "../../../../../src/models/ActionableError";
import { createExecResult } from "../../../../../src/utils/execResult";
import type { IosInstalledAppRecord } from "../../../../../src/utils/ios-cmdline-tools/iosInstalledApp";
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
const noGrants = { granted: [], denied: [] };

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
  return {
    installer: new IosDisposableAppInstaller({ simctl, files, commands, data, clearStorage }),
    operations,
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

  test("maps canonical grants and revokes and skips names without a simctl service", async () => {
    const { installer, commands } = harness();
    await installer.applyPermissions(simulator, appId, {
      granted: [
        "camera",
        "microphone",
        "location",
        "locationBackground",
        "photos",
        "photosAdd",
        "contacts",
        "calendar",
        "motion",
        "bluetooth",
        "speech",
        "nearbyWifi",
        "notifications",
      ],
      denied: ["camera", "bluetooth", "constructor"],
    });
    const expected = [
      "camera",
      "microphone",
      "location",
      "location-always",
      "photos",
      "photos-add",
      "contacts",
      "calendar",
      "motion",
    ];
    expect(commands.executeCommandArgs.mock.calls.map(([args]) => args)).toEqual([
      ...expected.map((service) => ["privacy", simulator, "grant", service, appId]),
      ["privacy", simulator, "revoke", "camera", appId],
    ]);
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
