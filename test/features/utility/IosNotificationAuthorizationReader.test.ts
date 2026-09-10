import { describe, expect, test } from "bun:test";
import * as path from "path";
import {
  BulletinBoardAuthorizationReader,
  extractSectionDataBase64,
  parseSettingsFromNestedXml,
  resolveDeviceDataRoot,
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
  test("extracts and strips whitespace from the base64 blob", async () => {
    const xml = outerXml({ "com.apple.MobileSMS": "QUJD\n\t\tREVG" });
    expect(await extractSectionDataBase64(xml, "com.apple.MobileSMS")).toBe("QUJDREVG");
  });

  test("returns null for a bundle with no section", async () => {
    const xml = outerXml({ "com.apple.MobileSMS": "QUJD" });
    expect(await extractSectionDataBase64(xml, "com.example.absent")).toBeNull();
  });

  // Issue #6583 follow-up (codex review): the previous ad-hoc regex tokenizer
  // required a space before the closing `/` (`<true />`) and did not match
  // Apple's actual plutil output, which emits no-space self-closing tags like
  // `<true/>`. A stray self-closing boolean sibling anywhere in the document
  // must not break parsing of an unrelated `<data>` blob.
  test("tolerates no-space self-closing tags elsewhere in the document", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>sectionInfoVersionNumber</key>
\t<integer>2</integer>
\t<key>migrationComplete</key>
\t<true/>
\t<key>legacySections</key>
\t<array/>
\t<key>sectionInfo</key>
\t<dict>
\t\t<key>com.apple.MobileSMS</key>
\t\t<data>QUJDREVG</data>
\t</dict>
</dict>
</plist>`;
    expect(await extractSectionDataBase64(xml, "com.apple.MobileSMS")).toBe("QUJDREVG");
  });

  // The previous regex tokenizer's `indexOf` consumers read raw XML text
  // without decoding entities, so an escaped bundle id would never match a
  // lookup by its literal (decoded) value. Reusing the structured parser
  // fixes this because xml2js decodes entities as part of parsing.
  test("decodes XML entities in dict keys before matching the bundle id", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>sectionInfo</key>
\t<dict>
\t\t<key>com.example.app&amp;co</key>
\t\t<data>QUJDREVG</data>
\t</dict>
</dict>
</plist>`;
    expect(await extractSectionDataBase64(xml, "com.example.app&co")).toBe("QUJDREVG");
  });
});

describe("parseSettingsFromNestedXml", () => {
  test("pulls integer settings keys", async () => {
    const xml = nestedXml({
      authorizationStatus: 2,
      alertType: 1,
      lockScreenSetting: 2,
      notificationCenterSetting: 2,
      pushSettings: 63,
    });
    expect(await parseSettingsFromNestedXml(xml)).toEqual({
      authorizationStatus: 2,
      alertType: 1,
      lockScreenSetting: 2,
      notificationCenterSetting: 2,
      pushSettings: 63,
    });
  });

  // Issue #6583: the archive's $objects array is a flat, order-dependent list
  // that can contain more than one dict shaped like the settings dict. A decoy
  // dict carrying only `authorizationStatus` (no sibling settings keys) must
  // lose to the real settings dict that also carries `pushSettings`/`alertType`,
  // even though the decoy appears first in document order.
  test("selects the coherent settings dict, not the first authorizationStatus match", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>$archiver</key>
\t<string>NSKeyedArchiver</string>
\t<key>$objects</key>
\t<array>
\t\t<string>$null</string>
\t\t<dict>
\t\t\t<key>authorizationStatus</key>
\t\t\t<integer>0</integer>
\t\t</dict>
\t\t<dict>
\t\t\t<key>alertType</key>
\t\t\t<integer>1</integer>
\t\t\t<key>authorizationStatus</key>
\t\t\t<integer>2</integer>
\t\t\t<key>lockScreenSetting</key>
\t\t\t<integer>2</integer>
\t\t\t<key>notificationCenterSetting</key>
\t\t\t<integer>2</integer>
\t\t\t<key>pushSettings</key>
\t\t\t<integer>63</integer>
\t\t</dict>
\t</array>
</dict>
</plist>`;
    expect(await parseSettingsFromNestedXml(xml)).toEqual({
      authorizationStatus: 2,
      alertType: 1,
      lockScreenSetting: 2,
      notificationCenterSetting: 2,
      pushSettings: 63,
    });
  });

  // Issue #6583 follow-up (codex review): the previous ad-hoc regex tokenizer
  // did not match no-space self-closing tags (`<true/>`, `<dict/>`) which is
  // exactly what plutil emits, so a self-closing sibling anywhere in the
  // `$objects` graph must not derail extraction of the real settings dict.
  test("tolerates no-space self-closing tags among the $objects siblings", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>$archiver</key>
\t<string>NSKeyedArchiver</string>
\t<key>$objects</key>
\t<array>
\t\t<string>$null</string>
\t\t<true/>
\t\t<dict/>
\t\t<dict>
\t\t\t<key>authorizationStatus</key>
\t\t\t<integer>3</integer>
\t\t\t<key>pushSettings</key>
\t\t\t<integer>7</integer>
\t\t</dict>
\t</array>
</dict>
</plist>`;
    expect(await parseSettingsFromNestedXml(xml)).toEqual({
      authorizationStatus: 3,
      pushSettings: 7,
      alertType: undefined,
      lockScreenSetting: undefined,
      notificationCenterSetting: undefined,
    });
  });

  // The previous regex tokenizer's `indexOf` consumers read raw XML text
  // without decoding entities, so an escaped sibling string value could
  // corrupt the scan of subsequent tags. Reusing the structured parser fixes
  // this because xml2js decodes entities as part of parsing.
  test("tolerates XML entities in sibling string values", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>$archiver</key>
\t<string>NSKeyedArchiver</string>
\t<key>$objects</key>
\t<array>
\t\t<string>Fish &amp; Chips &lt;shop&gt;</string>
\t\t<dict>
\t\t\t<key>authorizationStatus</key>
\t\t\t<integer>2</integer>
\t\t\t<key>alertType</key>
\t\t\t<integer>1</integer>
\t\t</dict>
\t</array>
</dict>
</plist>`;
    expect(await parseSettingsFromNestedXml(xml)).toEqual({
      authorizationStatus: 2,
      alertType: 1,
      pushSettings: undefined,
      lockScreenSetting: undefined,
      notificationCenterSetting: undefined,
    });
  });
});

describe("resolveDeviceDataRoot", () => {
  const original = process.env.CORESIMULATOR_DEVICE_SET_PATH;
  const restoreEnv = () => {
    if (original === undefined) {
      delete process.env.CORESIMULATOR_DEVICE_SET_PATH;
    } else {
      process.env.CORESIMULATOR_DEVICE_SET_PATH = original;
    }
  };

  test("honors CORESIMULATOR_DEVICE_SET_PATH when set", () => {
    process.env.CORESIMULATOR_DEVICE_SET_PATH = "/custom/device-set";
    try {
      expect(resolveDeviceDataRoot(SIM_UDID, "/home/tester")).toBe(
        path.join("/custom/device-set", SIM_UDID),
      );
    } finally {
      restoreEnv();
    }
  });

  test("falls back to the default CoreSimulator device set layout", () => {
    delete process.env.CORESIMULATOR_DEVICE_SET_PATH;
    try {
      expect(resolveDeviceDataRoot(SIM_UDID, "/home/tester")).toBe(
        path.join("/home/tester", "Library", "Developer", "CoreSimulator", "Devices", SIM_UDID),
      );
    } finally {
      restoreEnv();
    }
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

  test("provisional app (Home-like) maps to provisional and is allowed", async () => {
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

    // Provisional (quiet) authorization still delivers notifications, so `allowed`
    // is true; callers wanting full authorization check `authorizationStatus`.
    expect(result.authorizationStatus).toBe("provisional");
    expect(result.allowed).toBe(true);
    expect(result.alerts).toBe(false);
    expect(result.lockScreen).toBe(false);
    expect(result.notificationCenter).toBe(true);
  });

  test("ephemeral app (App Clip) maps to ephemeral and is allowed", async () => {
    const b64 = Buffer.from("bplist00").toString("base64");
    const { deps } = fakeDeps({
      outer: outerXml({ "com.example.clip": b64 }),
      nested: nestedXml({ authorizationStatus: 4 }),
    });
    const reader = new BulletinBoardAuthorizationReader(deps);
    const result = await reader.read(SIM_UDID, "com.example.clip");

    expect(result.authorizationStatus).toBe("ephemeral");
    expect(result.allowed).toBe(true);
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
