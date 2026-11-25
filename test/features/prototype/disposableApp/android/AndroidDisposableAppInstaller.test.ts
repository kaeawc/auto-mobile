import { beforeEach, describe, expect, test } from "bun:test";
import {
  AndroidDisposableAppInstaller,
  UNREADABLE_DISPOSABLE_APP_SIGNER,
} from "../../../../../src/features/prototype/disposableApp/android/AndroidDisposableAppInstaller";
import {
  DisposableAppManager,
  type DisposableAppInstallInput,
} from "../../../../../src/features/prototype/disposableApp/DisposableAppManager";
import { FileDisposableAppRegistry } from "../../../../../src/features/prototype/disposableApp/DisposableAppRegistry";
import {
  DISPOSABLE_APP_ID_PREFIX,
  disposableAppId,
} from "../../../../../src/features/prototype/disposableApp/disposableAppId";
import type {
  PackagePresence,
  PackageSigning,
  PackageSigningInspection,
} from "../../../../../src/models/PackageSigningInspection";
import { ActionableError } from "../../../../../src/models/ActionableError";
import { FakeAdbExecutor } from "../../../../fakes/FakeAdbExecutor";
import { FakeDisposableAppStamper } from "../../../../fakes/FakeDisposableAppStamper";
import { FakeTimer } from "../../../../fakes/FakeTimer";
import { InMemoryDisposableAppRegistryStore } from "../../../../fakes/InMemoryDisposableAppRegistryStore";
import fixture from "../../../../fixtures/prototype-spec/valid/platform-requires.json";

const DEVICE = "emulator-5554";
const APP = disposableAppId("android", "feedly");
const HOST = "ab".repeat(32);

function result(stdout: string, stderr = "") {
  return {
    stdout,
    stderr,
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: () => false,
  };
}

class FakeSigningReader {
  presence: PackagePresence = "installed";
  signing: PackageSigning = {
    status: "available",
    scheme: "v3",
    signerSha256: [HOST],
    signers: [],
  };
  unknownReason: string | undefined;

  async execute(appId: string): Promise<PackageSigningInspection> {
    return {
      appId,
      platform: "android",
      deviceId: DEVICE,
      userId: 0,
      userSource: "primary",
      presence: this.presence,
      ...(this.unknownReason ? { unknownReason: this.unknownReason } : {}),
      signing: this.signing,
      observation: {
        source: "dumpsys-package+apk-signing-block",
        fresh: true,
        observedAt: new Date(0).toISOString(),
        scope: { deviceId: DEVICE, userId: 0, appId },
        apiLevel: 35,
      },
    };
  }
}

let adb: FakeAdbExecutor;
let signing: FakeSigningReader;
let installer: AndroidDisposableAppInstaller;
let devices: string[];

beforeEach(() => {
  adb = new FakeAdbExecutor();
  adb.setDefaultResponse(result(""));
  adb.setAndroidApiLevel(34);
  signing = new FakeSigningReader();
  devices = [];
  installer = new AndroidDisposableAppInstaller((deviceId) => {
    devices.push(deviceId);
    return { adb, signing };
  });
});

describe("AndroidDisposableAppInstaller.install", () => {
  test("installs in place and keeps storage", async () => {
    adb.setCommandResponse("install -r", result("Performing Streamed Install\nSuccess"));
    await installer.install(DEVICE, APP, "/cache/feedly.apk");
    expect(adb.getExecutedArgv()).toEqual([["install", "-r", "/cache/feedly.apk"]]);
    expect(devices).toEqual([DEVICE]);
  });

  test("a Failure line fails the install with adb's message", async () => {
    adb.setCommandResponse(
      "install -r",
      result("", "adb: failed to install: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]"),
    );
    await expect(installer.install(DEVICE, APP, "/cache/feedly.apk")).rejects.toThrow(
      /INSTALL_FAILED_UPDATE_INCOMPATIBLE/,
    );
  });

  test("refuses an id outside the reserved prefix before any command", async () => {
    await expect(installer.install(DEVICE, "com.example.real", "/cache/x.apk")).rejects.toThrow(
      /reserved prefix|dev\.jasonpearson\.automobile\.app\./,
    );
    expect(adb.getExecutedArgv()).toEqual([]);
  });
});

describe("AndroidDisposableAppInstaller.resetStorage", () => {
  test("clears the app's storage with pm clear", async () => {
    adb.setCommandResponse("pm clear", result("Success"));
    await installer.resetStorage(DEVICE, APP);
    expect(adb.getExecutedArgv()).toEqual([["shell", "pm", "clear", APP]]);
  });

  test("a failed clear throws with adb's message", async () => {
    adb.setCommandResponse("pm clear", result("Failed"));
    await expect(installer.resetStorage(DEVICE, APP)).rejects.toThrow(
      /Clearing the storage of .* failed: Failed/,
    );
  });

  test("refuses an id outside the reserved prefix before any command", async () => {
    await expect(installer.resetStorage(DEVICE, "com.example.real")).rejects.toThrow(
      /reserved prefix|dev\.jasonpearson\.automobile\.app\./,
    );
    expect(adb.getExecutedArgv()).toEqual([]);
  });
});

/** `dumpsys package` for APP: each requested permission with its grant and flags for user 0. */
function dumpsys(permissions: Record<string, { granted: boolean; flags?: string }>): string {
  const names = Object.keys(permissions);
  return [
    `  Package [${APP}] (abc123):`,
    "    requested permissions:",
    ...names.map((permission) => `      ${permission}`),
    "    User 0: ceDataInode=1 installed=true",
    "      runtime permissions:",
    ...names.map(
      (permission) =>
        `        ${permission}: granted=${permissions[permission].granted}, flags=[ ${permissions[permission].flags ?? ""} ]`,
    ),
  ].join("\n");
}

const USER_FIXED = "USER_SET|USER_FIXED";

function pm(verb: string, permission: string, suffix = ""): string {
  return `shell pm ${verb} --user 0 '${APP}' 'android.permission.${permission}'${suffix}`;
}

describe("AndroidDisposableAppInstaller.applyPermissions", () => {
  test("grants and user-fixes denials, then reads back every declared name verified", async () => {
    adb.setCommandResponse(
      "dumpsys package",
      result(
        dumpsys({
          "android.permission.CAMERA": { granted: true },
          "android.permission.READ_CONTACTS": { granted: false, flags: USER_FIXED },
          "android.permission.ACCESS_FINE_LOCATION": { granted: true },
          "android.permission.ACCESS_COARSE_LOCATION": { granted: true },
        }),
      ),
    );
    const results = await installer.applyPermissions(DEVICE, APP, {
      declared: ["camera", "contacts", "location"],
      granted: ["camera", "location"],
      denied: ["contacts"],
    });
    expect(results).toEqual([
      { name: "camera", state: "granted", verified: true },
      { name: "contacts", state: "blocked", verified: true },
      { name: "location", state: "granted", verified: true },
    ]);
    expect(adb.getExecutedCommands()).toEqual([
      pm("clear-permission-flags", "CAMERA", " user-set user-fixed"),
      pm("grant", "CAMERA"),
      pm("revoke", "READ_CONTACTS"),
      pm("set-permission-flags", "READ_CONTACTS", " user-set user-fixed"),
      pm("clear-permission-flags", "ACCESS_FINE_LOCATION", " user-set user-fixed"),
      pm("grant", "ACCESS_FINE_LOCATION"),
      pm("clear-permission-flags", "ACCESS_COARSE_LOCATION", " user-set user-fixed"),
      pm("grant", "ACCESS_COARSE_LOCATION"),
      `shell dumpsys package '${APP}'`,
      `shell dumpsys package '${APP}'`,
      `shell dumpsys package '${APP}'`,
    ]);
  });

  test("a grant the device did not keep is reported unverified", async () => {
    adb.setCommandResponse(
      "dumpsys package",
      result(dumpsys({ "android.permission.CAMERA": { granted: false } })),
    );
    expect(
      await installer.applyPermissions(DEVICE, APP, {
        declared: ["camera"],
        granted: ["camera"],
        denied: [],
      }),
    ).toEqual([{ name: "camera", state: "notDetermined", verified: false }]);
  });

  test("prompt mode only reads, and reports each declared name notDetermined", async () => {
    adb.setCommandResponse(
      "dumpsys package",
      result(dumpsys({ "android.permission.CAMERA": { granted: false } })),
    );
    expect(
      await installer.applyPermissions(DEVICE, APP, {
        declared: ["camera"],
        granted: [],
        denied: [],
      }),
    ).toEqual([{ name: "camera", state: "notDetermined", verified: true }]);
    expect(adb.getExecutedCommands()).toEqual([`shell dumpsys package '${APP}'`]);
  });

  test("a name with no runtime grant is never written, and denying it is notRevocable", async () => {
    const results = await installer.applyPermissions(DEVICE, APP, {
      declared: ["photosAdd"],
      granted: [],
      denied: ["photosAdd"],
    });
    expect(results).toEqual([
      { name: "photosAdd", state: "granted", verified: false, reason: "notRevocable" },
    ]);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("a spec without permissions runs no command", async () => {
    expect(
      await installer.applyPermissions(DEVICE, APP, { declared: [], granted: [], denied: [] }),
    ).toEqual([]);
    expect(adb.getExecutedCommands()).toEqual([]);
    expect(adb.getApiLevelCalls()).toEqual([]);
  });

  test("refuses a grant and a deny that share a manifest permission before any write", async () => {
    await expect(
      installer.applyPermissions(DEVICE, APP, {
        declared: ["microphone", "speech"],
        granted: ["microphone"],
        denied: ["speech"],
      }),
    ).rejects.toThrow(/microphone and speech share android\.permission\.RECORD_AUDIO/);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("a pm exception fails with the command named", async () => {
    adb.setCommandResponse(
      "pm grant",
      result("", "Exception occurred while executing 'grant': SecurityException"),
    );
    await expect(
      installer.applyPermissions(DEVICE, APP, {
        declared: ["camera"],
        granted: ["camera"],
        denied: [],
      }),
    ).rejects.toThrow(/pm grant --user 0 '.*' 'android\.permission\.CAMERA'` failed: Exception/);
  });

  test("an unreadable API level refuses before any write", async () => {
    adb.setAndroidApiLevel(null);
    await expect(
      installer.applyPermissions(DEVICE, APP, {
        declared: ["camera"],
        granted: ["camera"],
        denied: [],
      }),
    ).rejects.toThrow(/Cannot read the API level of emulator-5554/);
    expect(adb.getExecutedCommands()).toEqual(["shell getprop ro.build.version.sdk"]);
  });
});

describe("AndroidDisposableAppInstaller device reads", () => {
  test("installedIds keeps exact prefix matches only, sorted", async () => {
    adb.setCommandResponse(
      "pm list packages",
      result(
        [
          `package:${DISPOSABLE_APP_ID_PREFIX}notes_0a1b2c3d`,
          `package:${APP}`,
          "package:com.example.dev.jasonpearson.automobile.app.other",
          "",
        ].join("\n"),
      ),
    );
    expect(await installer.installedIds(DEVICE, DISPOSABLE_APP_ID_PREFIX)).toEqual(
      [APP, `${DISPOSABLE_APP_ID_PREFIX}notes_0a1b2c3d`].sort(),
    );
  });

  test("inspect reports the normalized signer set, absence and unreadable signers", async () => {
    signing.signing = {
      status: "available",
      scheme: "v3",
      signerSha256: [HOST.toUpperCase()],
      signers: [],
    };
    expect(await installer.inspect(DEVICE, APP)).toEqual({ installed: true, signer: HOST });
    signing.signing = { status: "unavailable", reason: "pull failed" };
    expect(await installer.inspect(DEVICE, APP)).toEqual({
      installed: true,
      signer: UNREADABLE_DISPOSABLE_APP_SIGNER,
    });
    signing.presence = "absent";
    expect(await installer.inspect(DEVICE, APP)).toEqual({ installed: false });
  });

  test("inspect refuses to guess when presence is unknown", async () => {
    signing.presence = "unknown";
    signing.unknownReason = "dumpsys timed out";
    await expect(installer.inspect(DEVICE, APP)).rejects.toThrow(/dumpsys timed out/);
  });

  test("uninstall requires adb's Success line", async () => {
    adb.setCommandResponse("uninstall", result("Failure [DELETE_FAILED_INTERNAL_ERROR]"));
    await expect(installer.uninstall(DEVICE, APP)).rejects.toThrow(/DELETE_FAILED_INTERNAL_ERROR/);
  });
});

describe("AndroidDisposableAppInstaller behind DisposableAppManager", () => {
  function manager(): DisposableAppManager {
    const stamper = new FakeDisposableAppStamper(
      [
        {
          name: "media",
          capabilities: ["prototype_platform_v1", "prototype_platform_test_v1"],
          size: 2,
        },
      ],
      HOST,
    );
    return new DisposableAppManager({
      platforms: { android: { stamper, installer } },
      registry: new FileDisposableAppRegistry(new InMemoryDisposableAppRegistryStore()),
      timer: new FakeTimer(),
    });
  }

  test("removes a host-signed app but refuses one signed by another key", async () => {
    adb.setCommandResponse("install -r", result("Success"));
    adb.setCommandResponse("uninstall", result("Success"));
    adb.setCommandResponse(
      "dumpsys package",
      result(
        dumpsys({
          "android.permission.CAMERA": { granted: false },
          "android.permission.POST_NOTIFICATIONS": { granted: false },
        }),
      ),
    );
    const input: DisposableAppInstallInput = {
      deviceId: DEVICE,
      platform: "android",
      spec: fixture,
      app: { slug: "feedly", label: "Feedly" },
    };
    const apps = manager();
    await apps.install(input);
    expect(await apps.uninstall(DEVICE, "android", { appId: APP })).toEqual({
      removed: [{ appId: APP, reason: "requested" }],
      skipped: [],
    });
    adb.clearHistory();
    await apps.install(input);
    signing.signing = {
      status: "available",
      scheme: "v2",
      signerSha256: ["cd".repeat(32)],
      signers: [],
    };
    await expect(apps.uninstall(DEVICE, "android", { appId: APP })).rejects.toThrow(
      /not signed by this host's disposable-app key/,
    );
    expect(adb.wasCommandExecuted("uninstall")).toBe(false);
  });

  test("returns the read-back results, and a failed grant keeps the install recorded", async () => {
    adb.setCommandResponse("install -r", result("Success"));
    adb.setCommandResponse(
      "dumpsys package",
      result(
        dumpsys({
          "android.permission.CAMERA": { granted: true },
          "android.permission.POST_NOTIFICATIONS": { granted: false, flags: USER_FIXED },
        }),
      ),
    );
    const input: DisposableAppInstallInput = {
      deviceId: DEVICE,
      platform: "android",
      spec: fixture,
      app: {
        slug: "feedly",
        label: "Feedly",
        permissions: { grant: ["camera"], deny: ["notifications"] },
      },
    };
    const apps = manager();
    expect((await apps.install(input)).permissions.results).toEqual([
      { name: "camera", state: "granted", verified: true },
      { name: "notifications", state: "blocked", verified: true },
    ]);
    adb.setCommandResponse("pm grant", result("", "Exception occurred while executing 'grant'"));
    const failure = apps.install(input);
    await expect(failure).rejects.toBeInstanceOf(ActionableError);
    await expect(failure).rejects.toThrow(
      /is installed on emulator-5554 \(expires .*\), but its permissions were not applied: `pm grant/,
    );
    expect((await apps.list(DEVICE, "android")).map(({ appId }) => appId)).toEqual([APP]);
  });
});
