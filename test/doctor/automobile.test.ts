import { describe, test, expect, beforeEach } from "bun:test";
import {
  checkCtrlProxy,
  checkCtrlProxyVersion,
  checkDaemonVersion,
} from "../../src/doctor/checks/automobile";
import {
  LATEST_RELEASE_VERSION,
  RELEASE_VERSION,
  resolveAssetVersion,
} from "../../src/constants/release";
import { getMcpServerVersion } from "../../src/utils/mcpVersion";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";

describe("checkDaemonVersion", () => {
  test("returns pass status", () => {
    expect(checkDaemonVersion().status).toBe("pass");
  });

  test("reports the daemon JS package version, not the CtrlProxy version", () => {
    const result = checkDaemonVersion();

    expect(result.name).toBe("AutoMobile Daemon Version");
    expect(result.value).toBe(getMcpServerVersion());
    expect(result.message).toBe(`Version ${getMcpServerVersion()}`);
  });
});

describe("checkCtrlProxyVersion", () => {
  test("returns pass status", () => {
    expect(checkCtrlProxyVersion().status).toBe("pass");
  });

  test("reports the concrete on-device CtrlProxy version from the registry", () => {
    const result = checkCtrlProxyVersion();
    const expected = resolveAssetVersion(RELEASE_VERSION);

    expect(result.name).toBe("CtrlProxy Release Version");
    expect(result.value).toBe(expected);
    if (RELEASE_VERSION === LATEST_RELEASE_VERSION) {
      expect(result.message).toMatch(/\(latest\)$/);
    }
  });
});

describe("checkCtrlProxy", () => {
  let fakeAdb: FakeAdbExecutor;
  let fakeFactory: AdbClientFactory;

  beforeEach(() => {
    fakeAdb = new FakeAdbExecutor();
    fakeFactory = {
      create: () => fakeAdb,
    };
  });

  test("returns skip when no devices connected", async () => {
    fakeAdb.setDevices([]);

    const result = await checkCtrlProxy(fakeFactory);

    expect(result.name).toBe("CtrlProxy");
    expect(result.status).toBe("skip");
    expect(result.message).toBe("No Android devices connected");
  });
});
