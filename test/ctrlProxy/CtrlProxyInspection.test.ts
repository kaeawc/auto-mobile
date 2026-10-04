import { afterEach, beforeEach, expect, test } from "bun:test";
import { AndroidCtrlProxyManager } from "../../src/ctrlProxy/CtrlProxyManager";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeChecksumCalculator } from "../fakes/FakeChecksumCalculator";
import { FakeTimer } from "../fakes/FakeTimer";

const device = {
  deviceId: "inspection",
  platform: "android" as const,
  isEmulator: true,
  name: "Pixel",
};
let adb: FakeAdbExecutor;
beforeEach(() => {
  adb = new FakeAdbExecutor();
  AndroidCtrlProxyManager.resetInstances();
  AndroidCtrlProxyManager.setExpectedChecksumForTesting("expected");
});
afterEach(() => {
  AndroidCtrlProxyManager.resetInstances();
  AndroidCtrlProxyManager.setExpectedChecksumForTesting(null);
});

function installed(sha: string | null) {
  adb.setCommandResponse("shell pm list packages", {
    stdout: `package:${AndroidCtrlProxyManager.PACKAGE}\n`,
    stderr: "",
  });
  adb.setCommandResponse("shell pm path", {
    stdout: sha === null ? "" : "package:/data/app/base.apk",
    stderr: "",
  });
  adb.setCommandResponse("shell sha256sum", { stdout: `${sha} /data/app/base.apk`, stderr: "" });
}

function expectOnlyReads() {
  expect(
    adb
      .getExecutedCommands()
      .every(
        (command) =>
          command.startsWith("shell pm list packages") ||
          command.startsWith("shell pm path") ||
          command.startsWith("shell sha256sum"),
      ),
  ).toBe(true);
}

test("detached managers leave the registry and static factory untouched", () => {
  const liveFactory = { create: () => adb };
  const live = AndroidCtrlProxyManager.getInstance(device, liveFactory);
  const detached = AndroidCtrlProxyManager.createDetached(device, new FakeAdbExecutor());
  expect(detached).not.toBe(live);
  expect(AndroidCtrlProxyManager.getExistingInstance(device.deviceId)).toBe(live);
  expect(Reflect.get(AndroidCtrlProxyManager, "adbFactory")).toBe(liveFactory);
  const other = { ...device, deviceId: "other" };
  AndroidCtrlProxyManager.createDetached(other, liveFactory);
  expect(AndroidCtrlProxyManager.getExistingInstance("other")).toBeUndefined();
});

for (const [sha, status] of [
  ["EXPECTED", "compatible"],
  ["different", "mismatch"],
  [null, "unverifiable"],
] as const) {
  test(`inspectCompatibility reports ${status} using only reads`, async () => {
    installed(sha);
    const manager = AndroidCtrlProxyManager.createForTestingWithDeps(device, adb, new FakeTimer());
    const reading = await manager.inspectCompatibility();
    expect(reading.status).toBe(status);
    expect(reading.installedSha256).toBe(sha);
    expect(reading.installedShaSource).toBe(sha === null ? "none" : "device");
    expect(reading.knownPinMismatch).toBe(false);
    expectOnlyReads();
  });
}

test("inspectCompatibility reports not_installed without provisioning", async () => {
  expect(
    (await AndroidCtrlProxyManager.createDetached(device, adb).inspectCompatibility()).status,
  ).toBe("not_installed");
  expectOnlyReads();
});

test("empty checksum skips installed APK comparison", async () => {
  installed("different");
  AndroidCtrlProxyManager.setExpectedChecksumForTesting("");
  expect(
    (await AndroidCtrlProxyManager.createDetached(device, adb).inspectCompatibility()).status,
  ).toBe("skipped");
  expect(adb.getExecutedCommands()).toHaveLength(1);
});

for (const key of [
  "AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM",
  "AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED",
]) {
  test(`${key} skips without APK reads`, async () => {
    installed("different");
    const previous = process.env[key];
    process.env[key] = "1";
    try {
      expect(
        (await AndroidCtrlProxyManager.createDetached(device, adb).inspectCompatibility()).status,
      ).toBe("skipped");
      expect(adb.getExecutedCommands()).toHaveLength(1);
    } finally {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });
}

test("known pin mismatch fails closed even with preinstalled skip configured", async () => {
  installed("different");
  const previous = process.env.AUTOMOBILE_VERSION;
  const previousSkip = process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED;
  process.env.AUTOMOBILE_VERSION = "0.0.18";
  process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED = "1";
  try {
    const reading = await AndroidCtrlProxyManager.createDetached(
      device,
      adb,
    ).inspectCompatibility();
    expect(reading.status).toBe("mismatch");
    expect(reading.knownPinMismatch).toBe(true);
    expectOnlyReads();
  } finally {
    if (previous === undefined) {
      delete process.env.AUTOMOBILE_VERSION;
    } else {
      process.env.AUTOMOBILE_VERSION = previous;
    }
    if (previousSkip === undefined) {
      delete process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED;
    } else {
      process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED = previousSkip;
    }
  }
});

test("known pin treats an unreadable installed APK SHA as unverified mismatch", async () => {
  installed(null);
  const previous = process.env.AUTOMOBILE_VERSION;
  process.env.AUTOMOBILE_VERSION = "0.0.18";
  try {
    const reading = await AndroidCtrlProxyManager.createDetached(
      device,
      adb,
    ).inspectCompatibility();
    expect(reading.status).toBe("unverifiable");
    expect(reading.knownPinMismatch).toBe(true);
    expectOnlyReads();
  } finally {
    if (previous === undefined) {
      delete process.env.AUTOMOBILE_VERSION;
    } else {
      process.env.AUTOMOBILE_VERSION = previous;
    }
  }
});

test("unknown pin rejects before adb reads", async () => {
  AndroidCtrlProxyManager.setExpectedChecksumForTesting(null);
  const previous = process.env.AUTOMOBILE_VERSION;
  process.env.AUTOMOBILE_VERSION = "99.99.99";
  try {
    await expect(
      AndroidCtrlProxyManager.createDetached(device, adb).inspectCompatibility(),
    ).rejects.toThrow("cannot be integrity-verified");
    expect(adb.getExecutedCommands()).toEqual([]);
  } finally {
    if (previous === undefined) {
      delete process.env.AUTOMOBILE_VERSION;
    } else {
      process.env.AUTOMOBILE_VERSION = previous;
    }
  }
});

test("abort between path and hash stops further reads", async () => {
  installed("different");
  const controller = new AbortController();
  adb.abortAfterCommand("shell pm path", controller);
  await expect(
    AndroidCtrlProxyManager.createDetached(device, adb).inspectCompatibility(controller.signal),
  ).rejects.toThrow();
  expect(adb.getExecutedCommands()).toHaveLength(2);
});

test("local override inspection never populates or clears the shared checksum cache", async () => {
  const previous = process.env.AUTOMOBILE_CTRL_PROXY_APK_PATH;
  process.env.AUTOMOBILE_CTRL_PROXY_APK_PATH = "/fake/status-only.apk";
  AndroidCtrlProxyManager.setExpectedChecksumForTesting(null);
  const calculator = new FakeChecksumCalculator();
  calculator.checksum = "expected";
  installed("expected");
  const cache = Reflect.get(AndroidCtrlProxyManager, "apkOverrideChecksums");
  const before = Array.from(cache.entries());
  try {
    const manager = AndroidCtrlProxyManager.createForTestingWithDeps(
      device,
      adb,
      new FakeTimer(),
      undefined,
      calculator,
    );
    expect((await manager.inspectCompatibility()).status).toBe("compatible");
    expect(calculator.computedFiles).toEqual(["/fake/status-only.apk"]);
    expect(Array.from(cache.entries())).toEqual(before);
    calculator.shouldThrow = new Error("cannot read APK");
    expect((await manager.inspectCompatibility()).status).toBe("skipped");
    expect(Array.from(cache.entries())).toEqual(before);
  } finally {
    if (previous === undefined) {
      delete process.env.AUTOMOBILE_CTRL_PROXY_APK_PATH;
    } else {
      process.env.AUTOMOBILE_CTRL_PROXY_APK_PATH = previous;
    }
  }
});
