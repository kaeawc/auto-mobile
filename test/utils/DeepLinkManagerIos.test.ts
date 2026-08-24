import { describe, expect, test } from "bun:test";
import { DeepLinkManager, type HostExec } from "../../src/utils/DeepLinkManager";
import type { PlistReader } from "../../src/utils/ios-cmdline-tools/PlistClient";
import type { BootedDevice, ExecResult } from "../../src/models";
import type { AppBundleMetadata } from "../../src/utils/ios-cmdline-tools/AppBundleMetadataClient";
import { FakeSimCtlClient } from "../fakes/FakeSimCtlClient";

const SIM_UDID = "7B3A3792-DB53-4654-BA94-27A1D305C3B7";
const PHYSICAL_UDID = "00008110-000A1234567890AB";

const iosDevice: BootedDevice = {
  name: "iPhone 16 Pro",
  platform: "ios",
  deviceId: SIM_UDID,
};

function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (value: string) => stdout.includes(value),
  };
}

/**
 * A fake host exec that maps command-substring matches to canned stdout. Calls
 * are recorded as the reconstructed `file arg arg …` line so substring routing
 * still works against the argv-based {@link HostExec} signature.
 *
 * `plutil` reading from stdin (`… -- -`) echoes the piped content for callers
 * that need it. DeepLinkManager itself uses the typed AppBundleMetadataClient
 * for code-signing metadata rather than sending that data through this executor.
 */
function fakeHostExec(routes: Array<{ match: string; stdout?: string; throws?: Error }>): {
  exec: HostExec;
  plist: PlistReader;
  calls: string[];
} {
  const calls: string[] = [];
  const exec: HostExec = async (file: string, args: string[], stdin?: string) => {
    const command = [file, ...args].join(" ");
    calls.push(command);
    for (const route of routes) {
      if (command.includes(route.match)) {
        if (route.throws) {
          throw route.throws;
        }
        return execResult(route.stdout ?? "");
      }
    }
    return execResult("");
  };
  const plist: PlistReader = {
    readJsonFile: async (path) => {
      const command = `plutil -convert json -o - -- ${path}`;
      const route = routes.find((candidate) => command.includes(candidate.match));
      if (route?.throws) {
        throw route.throws;
      }
      return JSON.parse(route?.stdout ?? "{}");
    },
    readJsonBytes: async (bytes) => JSON.parse(bytes.toString("utf8")),
    readXmlFile: async () => "",
    readXmlBytes: async () => "",
    extractRawFile: async () => "",
  };
  return { exec, plist, calls };
}

function fakeMetadata(entitlements: Record<string, unknown> | null = null): AppBundleMetadata {
  return { readEntitlements: async () => entitlements };
}

describe("DeepLinkManager iOS", () => {
  test("returns schemes from CFBundleURLTypes for a schemes-only app", async () => {
    const simctl = new FakeSimCtlClient();
    const appPath = "/sim/Containers/Bundle/Application/ABC/MyApp.app";
    simctl.setCommandArgsResult(
      ["get_app_container", SIM_UDID, "com.example.myapp", "app"],
      appPath,
    );

    const infoPlist = JSON.stringify({
      CFBundleURLTypes: [
        { CFBundleURLName: "Main", CFBundleURLSchemes: ["myapp", "myapp-alt"] },
        { CFBundleURLSchemes: ["myapp"] }, // duplicate scheme deduped
      ],
    });
    const { exec, plist, calls } = fakeHostExec([
      { match: "plutil -convert json", stdout: infoPlist },
    ]);

    const manager = new DeepLinkManager(
      iosDevice,
      null,
      simctl as any,
      exec,
      plist,
      fakeMetadata(),
    );
    const result = await manager.getDeepLinks("com.example.myapp");

    expect(result.success).toBe(true);
    expect(result.appId).toBe("com.example.myapp");
    expect(result.deepLinks.schemes).toEqual(["myapp", "myapp-alt"]);
    expect(result.deepLinks.hosts).toEqual([]);
    expect(result.deepLinks.intentFilters).toHaveLength(1);
    expect(result.deepLinks.intentFilters[0].data).toEqual([
      { scheme: "myapp" },
      { scheme: "myapp-alt" },
    ]);

    // get_app_container routes through simctl (xcrun simctl), not host exec.
    const simctlCalls = simctl.getMethodCalls("executeCommandArgs");
    expect(
      simctlCalls.some((c) => {
        const args = c.args as string[];
        return args[0] === "get_app_container" && args[3] === "app";
      }),
    ).toBe(true);
    expect(calls).toHaveLength(0);
    expect(simctlCalls.every((c) => !String(c.command).includes("plutil"))).toBe(true);
  });

  test("returns universal-link hosts from associated-domains entitlement", async () => {
    const simctl = new FakeSimCtlClient();
    const appPath = "/sim/MyApp.app";
    simctl.setCommandArgsResult(
      ["get_app_container", SIM_UDID, "com.example.myapp", "app"],
      appPath,
    );

    const infoPlist = JSON.stringify({
      CFBundleURLTypes: [{ CFBundleURLSchemes: ["myapp"] }],
      CFBundleDocumentTypes: [{ LSItemContentTypes: ["public.image"] }],
    });
    const entitlements = JSON.stringify({
      "com.apple.developer.associated-domains": [
        "applinks:example.com",
        "applinks:www.example.com",
        "webcredentials:example.com", // non-applinks ignored
      ],
    });
    const { exec, plist } = fakeHostExec([
      { match: "plutil -convert json -o - -- /sim/MyApp.app/Info.plist", stdout: infoPlist },
    ]);

    const manager = new DeepLinkManager(
      iosDevice,
      null,
      simctl as any,
      exec,
      plist,
      fakeMetadata(JSON.parse(entitlements)),
    );
    const result = await manager.getDeepLinks("com.example.myapp");

    expect(result.success).toBe(true);
    expect(result.deepLinks.schemes).toEqual(["myapp"]);
    expect(result.deepLinks.hosts).toEqual(["example.com", "www.example.com"]);
    expect(result.deepLinks.supportedMimeTypes).toEqual(["public.image"]);
    expect(result.deepLinks.intentFilters[0].data).toEqual([
      { scheme: "myapp" },
      { host: "example.com" },
      { host: "www.example.com" },
    ]);
  });

  test("unsigned bundle with no entitlements yields empty hosts (not an error)", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsResult(
      ["get_app_container", SIM_UDID, "com.example.myapp", "app"],
      "/sim/MyApp.app",
    );
    const infoPlist = JSON.stringify({ CFBundleURLTypes: [{ CFBundleURLSchemes: ["myapp"] }] });
    const { exec, plist } = fakeHostExec([{ match: "plutil -convert json", stdout: infoPlist }]);

    const manager = new DeepLinkManager(
      iosDevice,
      null,
      simctl as any,
      exec,
      plist,
      fakeMetadata(),
    );
    const result = await manager.getDeepLinks("com.example.myapp");

    expect(result.success).toBe(true);
    expect(result.deepLinks.schemes).toEqual(["myapp"]);
    expect(result.deepLinks.hosts).toEqual([]);
  });

  test("metadata inspection errors make iOS deep-link discovery fail", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsResult(
      ["get_app_container", SIM_UDID, "com.example.myapp", "app"],
      "/sim/MyApp.app",
    );
    const infoPlist = JSON.stringify({ CFBundleURLTypes: [{ CFBundleURLSchemes: ["myapp"] }] });
    const { exec, plist } = fakeHostExec([{ match: "plutil -convert json", stdout: infoPlist }]);
    const metadata: AppBundleMetadata = {
      readEntitlements: async () => {
        throw new Error("codesign is unavailable");
      },
    };
    const manager = new DeepLinkManager(iosDevice, null, simctl as any, exec, plist, metadata);

    const result = await manager.getDeepLinks("com.example.myapp");

    expect(result.success).toBe(false);
    expect(result.error).toContain("codesign is unavailable");
  });

  test("app not installed returns success:false with descriptive error", async () => {
    const simctl = new FakeSimCtlClient();
    // get_app_container ... app returns empty (FakeSimCtlClient default for app variant)
    const { exec, plist } = fakeHostExec([]);

    const manager = new DeepLinkManager(
      iosDevice,
      null,
      simctl as any,
      exec,
      plist,
      fakeMetadata(),
    );
    const result = await manager.getDeepLinks("com.example.notinstalled");

    expect(result.success).toBe(false);
    expect(result.error).toContain("not installed");
    expect(result.deepLinks.schemes).toEqual([]);
  });

  test("malformed plist JSON returns success:false without throwing", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsResult(
      ["get_app_container", SIM_UDID, "com.example.myapp", "app"],
      "/sim/MyApp.app",
    );
    const { exec, plist } = fakeHostExec([
      { match: "plutil -convert json", stdout: "<<<not json>>>" },
    ]);

    const manager = new DeepLinkManager(
      iosDevice,
      null,
      simctl as any,
      exec,
      plist,
      fakeMetadata(),
    );
    const result = await manager.getDeepLinks("com.example.myapp");

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.deepLinks.schemes).toEqual([]);
  });

  test("physical-device UDID returns explicit not-yet-implemented error", async () => {
    const simctl = new FakeSimCtlClient();
    const { exec, plist, calls } = fakeHostExec([]);
    const physicalDevice: BootedDevice = {
      name: "iPhone (physical)",
      platform: "ios",
      deviceId: PHYSICAL_UDID,
    };

    const manager = new DeepLinkManager(
      physicalDevice,
      null,
      simctl as any,
      exec,
      plist,
      fakeMetadata(),
    );
    const result = await manager.getDeepLinks("com.example.myapp");

    expect(result.success).toBe(false);
    expect(result.error).toContain("not yet implemented");
    // No simctl or host exec invoked for physical devices.
    expect(simctl.getMethodCalls("executeCommandArgs")).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});
