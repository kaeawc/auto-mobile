import { describe, expect, test } from "bun:test";
import {
  BulletinBoardAuthorizationReader,
  extractSectionDataBase64,
  parseSettingsFromNestedXml,
  type BulletinBoardReaderDeps,
} from "../../../src/features/utility/ios/IosNotificationAuthorizationReader";

const SIM_UDID = "7B3A3792-DB53-4654-BA94-27A1D305C3B7";
const PHYSICAL_UDID = "00008110-000A1234567890AB";

/** Build an outer VersionedSectionInfo XML with one `<data>` blob per bundle. */
function outerXml(sections: Record<string, string>): string {
  const entries = Object.entries(sections)
    .map(([bundle, b64]) => `\t\t<key>${bundle}</key>\n\t\t<data>\n\t\t${b64}\n\t\t</data>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>sectionInfo</key>
\t<dict>
${entries}
\t</dict>
\t<key>sectionInfoVersionNumber</key>
\t<integer>2</integer>
</dict>
</plist>`;
}

/** Build the decoded nested-blob XML (a settings dict) for given scalars. */
function nestedXml(s: {
  authorizationStatus?: number;
  alertType?: number;
  lockScreenSetting?: number;
  notificationCenterSetting?: number;
  pushSettings?: number;
}): string {
  const lines: string[] = [];
  const add = (k: string, v?: number) => {
    if (v !== undefined) {
      lines.push(`\t\t\t<key>${k}</key>\n\t\t\t<integer>${v}</integer>`);
    }
  };
  add("alertType", s.alertType);
  add("authorizationStatus", s.authorizationStatus);
  add("lockScreenSetting", s.lockScreenSetting);
  add("notificationCenterSetting", s.notificationCenterSetting);
  add("pushSettings", s.pushSettings);
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>$archiver</key>
\t<string>NSKeyedArchiver</string>
\t<key>$objects</key>
\t<array>
\t\t<string>$null</string>
\t\t<dict>
${lines.join("\n")}
\t\t</dict>
\t</array>
</dict>
</plist>`;
}

/** Fake deps: maps the outer path to canned plutil-xml; nested blobs matched by temp path. */
function fakeDeps(opts: { outer?: string | Error; nested?: string }): {
  deps: BulletinBoardReaderDeps;
  plutilPaths: string[];
} {
  const plutilPaths: string[] = [];
  let lastTemp = "";
  const deps: BulletinBoardReaderDeps = {
    plutilToXml: async (p: string) => {
      plutilPaths.push(p);
      if (p === lastTemp) {
        return opts.nested ?? "";
      }
      if (opts.outer instanceof Error) {
        throw opts.outer;
      }
      return opts.outer ?? "";
    },
    writeTemp: async () => {
      lastTemp = `/tmp/fake-blob-${plutilPaths.length}.bplist`;
      return lastTemp;
    },
    rmTemp: async () => {},
    deviceDataRoot: (udid: string) => `/fake/CoreSimulator/Devices/${udid}`,
  };
  return { deps, plutilPaths };
}

describe("extractSectionDataBase64", () => {
  test("extracts and strips whitespace from the base64 blob", () => {
    const xml = outerXml({ "com.apple.MobileSMS": "QUJD\n\t\tREVG" });
    expect(extractSectionDataBase64(xml, "com.apple.MobileSMS")).toBe("QUJDREVG");
  });

  test("returns null for a bundle with no section", () => {
    const xml = outerXml({ "com.apple.MobileSMS": "QUJD" });
    expect(extractSectionDataBase64(xml, "com.example.absent")).toBeNull();
  });
});

describe("parseSettingsFromNestedXml", () => {
  test("pulls integer settings keys", () => {
    const xml = nestedXml({
      authorizationStatus: 2,
      alertType: 1,
      lockScreenSetting: 2,
      notificationCenterSetting: 2,
      pushSettings: 63,
    });
    expect(parseSettingsFromNestedXml(xml)).toEqual({
      authorizationStatus: 2,
      alertType: 1,
      lockScreenSetting: 2,
      notificationCenterSetting: 2,
      pushSettings: 63,
    });
  });
});

describe("BulletinBoardAuthorizationReader", () => {
  test("authorized app (MobileSMS-like) maps to authorized + allowed", async () => {
    const b64 = Buffer.from("bplist00-placeholder").toString("base64");
    const { deps } = fakeDeps({
      outer: outerXml({ "com.apple.MobileSMS": b64 }),
      nested: nestedXml({
        authorizationStatus: 2,
        alertType: 1,
        lockScreenSetting: 2,
        notificationCenterSetting: 2,
        pushSettings: 63,
      }),
    });
    const reader = new BulletinBoardAuthorizationReader(deps);
    const result = await reader.read(SIM_UDID, "com.apple.MobileSMS");

    expect(result).toMatchObject({
      supported: true,
      method: "ios_bulletinboard_plist",
      allowed: true,
      authorizationStatus: "authorized",
      lockScreen: true,
      notificationCenter: true,
      alerts: true,
    });
  });

  test("provisional app (Home-like) maps to provisional, not allowed", async () => {
    const b64 = Buffer.from("bplist00").toString("base64");
    const { deps } = fakeDeps({
      outer: outerXml({ "com.apple.Home": b64 }),
      nested: nestedXml({
        authorizationStatus: 3,
        alertType: 0,
        lockScreenSetting: 1,
        notificationCenterSetting: 2,
        pushSettings: 7,
      }),
    });
    const reader = new BulletinBoardAuthorizationReader(deps);
    const result = await reader.read(SIM_UDID, "com.apple.Home");

    expect(result.authorizationStatus).toBe("provisional");
    expect(result.allowed).toBe(false);
    expect(result.alerts).toBe(false);
    expect(result.lockScreen).toBe(false);
    expect(result.notificationCenter).toBe(true);
  });

  test("denied app maps to denied + allowed false", async () => {
    const b64 = Buffer.from("bplist00").toString("base64");
    const { deps } = fakeDeps({
      outer: outerXml({ "com.example.app": b64 }),
      nested: nestedXml({ authorizationStatus: 1 }),
    });
    const reader = new BulletinBoardAuthorizationReader(deps);
    const result = await reader.read(SIM_UDID, "com.example.app");
    expect(result.authorizationStatus).toBe("denied");
    expect(result.allowed).toBe(false);
  });

  test("notDetermined app maps to notDetermined", async () => {
    const b64 = Buffer.from("bplist00").toString("base64");
    const { deps } = fakeDeps({
      outer: outerXml({ "com.example.app": b64 }),
      nested: nestedXml({ authorizationStatus: 0 }),
    });
    const reader = new BulletinBoardAuthorizationReader(deps);
    const result = await reader.read(SIM_UDID, "com.example.app");
    expect(result.authorizationStatus).toBe("notDetermined");
    expect(result.allowed).toBe(false);
  });

  test("app with no section registered returns warning, allowed null, not error", async () => {
    const { deps } = fakeDeps({
      outer: outerXml({ "com.apple.MobileSMS": "QUJD" }),
    });
    const reader = new BulletinBoardAuthorizationReader(deps);
    const result = await reader.read(SIM_UDID, "com.example.neverlaunched");

    expect(result.supported).toBe(true);
    expect(result.allowed).toBeNull();
    expect(result.warning).toContain("No notification section registered");
    expect(result.error).toBeUndefined();
  });

  test("missing/unreadable plist returns warning, never throws", async () => {
    const { deps } = fakeDeps({ outer: new Error("ENOENT") });
    const reader = new BulletinBoardAuthorizationReader(deps);
    const result = await reader.read(SIM_UDID, "com.apple.MobileSMS");

    expect(result.supported).toBe(true);
    expect(result.allowed).toBeNull();
    expect(result.warning).toContain("not found or unreadable");
    expect(result.error).toBeUndefined();
  });

  test("physical device returns unsupported with simulator-only error", async () => {
    const { deps } = fakeDeps({ outer: outerXml({}) });
    const reader = new BulletinBoardAuthorizationReader(deps);
    const result = await reader.read(PHYSICAL_UDID, "com.apple.MobileSMS");

    expect(result.supported).toBe(false);
    expect(result.method).toBe("unsupported");
    expect(result.error).toContain("simulators");
  });
});
