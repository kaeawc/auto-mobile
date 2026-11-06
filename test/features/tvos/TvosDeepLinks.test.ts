import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { DeepLinkManager } from "../../../src/features/utility/DeepLinkManager";
import { GetDeepLinks } from "../../../src/features/utility/GetDeepLinks";
import type { PhysicalIosBundleSource } from "../../../src/features/utility/DeepLinkManager";
import type { PlistReader } from "../../../src/utils/ios-cmdline-tools/PlistClient";
import type { AppBundleMetadata } from "../../../src/utils/ios-cmdline-tools/AppBundleMetadataClient";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeSimctl } from "../../fakes/FakeSimctl";
import { FakeTimer } from "../../fakes/FakeTimer";

const TV_UDID = "5B7E1C3D-2A4F-4E6B-8C9D-1E2F3A4B5C6D";
const BUNDLE = "com.example.television";
const APP_PATH = "/sim/Containers/Bundle/Application/TV/Television.app";

const tv: BootedDevice = {
  name: "Apple TV 4K (3rd generation)",
  deviceId: TV_UDID,
  platform: "tvos",
};

function plistReturning(files: Record<string, unknown>): PlistReader {
  return {
    readJsonFile: async (path) => {
      if (!(path in files)) {
        throw new Error(`unexpected plist read: ${path}`);
      }
      return files[path];
    },
    readJsonBytes: async (bytes) => JSON.parse(bytes.toString("utf8")),
    readXmlFile: async () => "",
    readXmlBytes: async () => "",
    extractRawFile: async () => "",
  };
}

const noEntitlements: AppBundleMetadata = { readEntitlements: async () => null };

const untouchedDeviceApps: PhysicalIosBundleSource = {
  getInstalledAppInfo: async () => {
    throw new Error("physical bundle lookup must not run for an Apple TV");
  },
  withInstalledAppBundle: async () => {
    throw new Error("physical bundle copy must not run for an Apple TV");
  },
};

function manager(device: BootedDevice, simctl: FakeSimctl, plist: PlistReader): DeepLinkManager {
  return new DeepLinkManager(device, new FakeAdbClientFactory(), {
    simctl,
    plist,
    appBundleMetadata: noEntitlements,
    deviceApps: untouchedDeviceApps,
    timer: new FakeTimer(),
  });
}

describe("getDeepLinks on an Apple TV simulator", () => {
  test("reads custom schemes from the installed app's CFBundleURLTypes", async () => {
    const simctl = new FakeSimctl();
    simctl.setCommandArgsResult(["get_app_container", TV_UDID, BUNDLE, "app"], APP_PATH);
    const plist = plistReturning({
      [`${APP_PATH}/Info.plist`]: {
        CFBundleURLTypes: [{ CFBundleURLSchemes: ["television", "tv-alt"] }],
      },
    });

    const result = await manager(tv, simctl, plist).getDeepLinks(BUNDLE);

    expect(result.success).toBe(true);
    expect(result.appId).toBe(BUNDLE);
    expect(result.deepLinks.schemes).toEqual(["television", "tv-alt"]);
    expect(result.deepLinks.hosts).toEqual([]);
    expect(result.deepLinks.intentFilters[0]?.data).toEqual([
      { scheme: "television" },
      { scheme: "tv-alt" },
    ]);
  });

  test("reports an app that is not installed on the Apple TV", async () => {
    const simctl = new FakeSimctl();
    simctl.setCommandArgsError(
      ["get_app_container", TV_UDID, BUNDLE, "app"],
      new Error("No such file or directory"),
    );

    const result = await manager(tv, simctl, plistReturning({})).getDeepLinks(BUNDLE);

    expect(result.success).toBe(false);
    expect(result.error).toBe(`App ${BUNDLE} is not installed on ${TV_UDID}`);
  });

  test("refuses a non-simulator UDID without a physical bundle copy", async () => {
    const simctl = new FakeSimctl();
    const hardware: BootedDevice = { ...tv, deviceId: "00008110-000A1234567890AB" };

    const result = await manager(hardware, simctl, plistReturning({})).getDeepLinks(BUNDLE);

    expect(result.success).toBe(false);
    expect(result.error).toContain("only Apple TV simulators");
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
  });

  test("GetDeepLinks returns the schemes without an Android App Links read", async () => {
    const simctl = new FakeSimctl();
    simctl.setCommandArgsResult(["get_app_container", TV_UDID, BUNDLE, "app"], APP_PATH);
    const plist = plistReturning({
      [`${APP_PATH}/Info.plist`]: { CFBundleURLTypes: [{ CFBundleURLSchemes: ["television"] }] },
    });

    const result = await new GetDeepLinks(tv, manager(tv, simctl, plist)).execute(BUNDLE);

    expect(result.success).toBe(true);
    expect(result.deepLinks.schemes).toEqual(["television"]);
    expect(result.appLinks).toBeUndefined();
  });
});
