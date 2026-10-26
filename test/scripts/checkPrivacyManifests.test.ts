import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  checkPrivacyManifests,
  findApiUsages,
  main,
  parsePrivacyManifest,
  stripSwiftNonCode,
} from "../../scripts/ios/check-privacy-manifests";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function manifest(
  entries: ReadonlyArray<{ category: string; reasons: readonly string[] }>,
  extra = "",
): string {
  const accessed = entries
    .map(
      (entry) => `<dict>
<key>NSPrivacyAccessedAPIType</key><string>NSPrivacyAccessedAPICategory${entry.category}</string>
<key>NSPrivacyAccessedAPITypeReasons</key><array>${entry.reasons.map((r) => `<string>${r}</string>`).join("")}</array>
</dict>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>NSPrivacyTracking</key><false/>
<key>NSPrivacyTrackingDomains</key><array/>
<key>NSPrivacyCollectedDataTypes</key><array>${extra}</array>
<key>NSPrivacyAccessedAPITypes</key><array>${accessed}</array>
</dict></plist>`;
}

const lib = "ios/prototype-agent/Sources/AutoMobilePrototypeAgentCore";
const bootTime = [{ category: "SystemBootTime", reasons: ["35F9.1"] }];

describe("stripSwiftNonCode", () => {
  test("blanks comments and strings but keeps line numbers", () => {
    const source =
      'let a = "systemUptime" // systemUptime\n/* nested /* UserDefaults */ x */\nlet b = 1';
    const stripped = stripSwiftNonCode(source);
    expect(stripped).not.toContain("systemUptime");
    expect(stripped).not.toContain("UserDefaults");
    expect(stripped.split("\n")).toHaveLength(3);
    expect(stripped).toContain("let b = 1");
  });

  test("blanks multi-line string literals", () => {
    expect(stripSwiftNonCode('let s = """\nUserDefaults\n"""\nlet t = 2')).not.toContain(
      "UserDefaults",
    );
  });
});

describe("findApiUsages", () => {
  test("maps symbols to Apple's categories with line numbers", () => {
    const usages = findApiUsages(
      "A.swift",
      "let t = ProcessInfo.processInfo.systemUptime\n\nlet d = UserDefaults.standard\nlet m = url.activeInputModes",
    );
    expect(usages.map((u) => [u.symbol, u.line])).toEqual([
      ["systemUptime", 1],
      ["UserDefaults", 3],
      ["activeInputModes", 4],
    ]);
  });

  test("stat family counts only as a call, not as a member or substring", () => {
    expect(
      findApiUsages("A.swift", "var i = stat()\nlstat(p, &i)\nDarwin.fstat(fd, &i)"),
    ).toHaveLength(3);
    expect(
      findApiUsages("A.swift", "cache.stat(path)\nlet status = 1\nstatic let stat = 2"),
    ).toHaveLength(0);
  });

  test("ignores symbols in comments and strings", () => {
    expect(findApiUsages("A.swift", '// systemUptime\nlet s = "UserDefaults"')).toHaveLength(0);
  });
});

describe("checkPrivacyManifests", () => {
  const clean = manifest([]);

  test("passes when no required-reason API is used", async () => {
    expect(
      await checkPrivacyManifests(
        { [`${lib}/A.swift`]: "let x = 1" },
        { library: clean, app: clean },
      ),
    ).toEqual([]);
  });

  test("fails a fixture that adds systemUptime without a manifest entry", async () => {
    const problems = await checkPrivacyManifests(
      { [`${lib}/A.swift`]: "let t = ProcessInfo.processInfo.systemUptime" },
      { library: clean, app: clean },
    );
    expect(problems).toEqual([
      `AutoMobilePrototype: NSPrivacyAccessedAPICategorySystemBootTime is used (systemUptime at ${lib}/A.swift:1) but has no declared reason`,
      `ProtoViewer: NSPrivacyAccessedAPICategorySystemBootTime is used (systemUptime at ${lib}/A.swift:1) but has no declared reason`,
    ]);
  });

  test("passes once the entry carries a valid reason", async () => {
    const declared = manifest(bootTime);
    const files = { [`${lib}/A.swift`]: "let t = ProcessInfo.processInfo.systemUptime" };
    expect(await checkPrivacyManifests(files, { library: declared, app: declared })).toEqual([]);
  });

  test("library excludes the injectable agent files; the app does not", async () => {
    const files = {
      "ios/prototype-agent/Sources/AutoMobilePrototypeAgent/PrototypeAgent.swift":
        "let t = ProcessInfo.processInfo.systemUptime",
    };
    expect(await checkPrivacyManifests(files, { library: clean, app: manifest(bootTime) })).toEqual(
      [],
    );
  });

  test("app-only sources need only the app manifest", async () => {
    const files = { "ios/prototype-agent/ProtoViewer/V.swift": "let d = UserDefaults.standard" };
    const problems = await checkPrivacyManifests(files, {
      library: clean,
      app: manifest([{ category: "UserDefaults", reasons: ["CA92.1"] }]),
    });
    expect(problems).toEqual([]);
  });

  test("rejects an empty or invalid reason, a stale entry and a duplicate", async () => {
    const files = { [`${lib}/A.swift`]: "let t = ProcessInfo.processInfo.systemUptime" };
    const problems = await checkPrivacyManifests(files, {
      library: manifest([{ category: "SystemBootTime", reasons: [] }]),
      app: manifest([
        { category: "SystemBootTime", reasons: ["CA92.1"] },
        { category: "DiskSpace", reasons: ["85F4.1"] },
        { category: "DiskSpace", reasons: ["85F4.1"] },
      ]),
    });
    expect(problems).toEqual([
      "AutoMobilePrototype: NSPrivacyAccessedAPICategorySystemBootTime is declared with no reason code",
      "ProtoViewer: category NSPrivacyAccessedAPICategoryDiskSpace is declared twice",
      "ProtoViewer: 'CA92.1' is not a valid reason for NSPrivacyAccessedAPICategorySystemBootTime",
      "ProtoViewer: NSPrivacyAccessedAPICategoryDiskSpace is declared but no compiled source uses it (stale)",
    ]);
  });

  test("requires no tracking and no collected data", async () => {
    const collected = manifest([], "<dict/>");
    const problems = await checkPrivacyManifests({}, { library: collected, app: clean });
    expect(problems).toEqual([
      "AutoMobilePrototype: NSPrivacyCollectedDataTypes must be an empty array (collects nothing)",
    ]);
  });

  test("parses reasons from the plist structure", async () => {
    const parsed = await parsePrivacyManifest(
      manifest([{ category: "FileTimestamp", reasons: ["3B52.1", "C617.1"] }]),
    );
    expect(parsed.declarations).toEqual([
      { category: "NSPrivacyAccessedAPICategoryFileTimestamp", reasons: ["3B52.1", "C617.1"] },
    ]);
  });
});

describe("committed manifests", () => {
  test("match the required-reason APIs in the real sources", async () => {
    expect(await main(repoRoot)).toBe(0);
  });

  test("ship with the library target and the ProtoViewer bundle", () => {
    const packageSwift = readFileSync(`${repoRoot}Package.swift`, "utf8");
    const target = packageSwift.slice(packageSwift.indexOf('path: "ios/prototype-agent/Sources"'));
    expect(target.slice(0, target.indexOf(".target("))).toContain(
      'resources: [.process("PrivacyInfo.xcprivacy")]',
    );
    const build = readFileSync(`${repoRoot}scripts/ios/protoviewer-build.sh`, "utf8");
    expect(build).toContain(
      '"${viewer_root}/PrivacyInfo.xcprivacy" "${app}/PrivacyInfo.xcprivacy"',
    );
  });
});
