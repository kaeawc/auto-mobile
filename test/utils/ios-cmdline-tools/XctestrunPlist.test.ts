import { describe, expect, test } from "bun:test";
import {
  parsePlist,
  buildPlist,
  injectUITestEnvironment,
} from "../../../src/utils/ios-cmdline-tools/XctestrunPlist";

/**
 * A minimal but representative format-version-1 xctestrun: two test targets
 * (a unit-test bundle and a UI-test bundle), each with an EnvironmentVariables
 * dict, plus the trailing __xctestrun_metadata__ entry.
 */
const SAMPLE_XCTESTRUN = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CtrlProxyTests</key>
\t<dict>
\t\t<key>BlueprintName</key>
\t\t<string>CtrlProxyTests</string>
\t\t<key>EnvironmentVariables</key>
\t\t<dict>
\t\t\t<key>TERM</key>
\t\t\t<string>dumb</string>
\t\t</dict>
\t\t<key>TestBundlePath</key>
\t\t<string>__TESTROOT__/Debug-iphonesimulator/CtrlProxyTests.xctest</string>
\t</dict>
\t<key>CtrlProxyUITests</key>
\t<dict>
\t\t<key>BlueprintName</key>
\t\t<string>CtrlProxyUITests</string>
\t\t<key>EnvironmentVariables</key>
\t\t<dict>
\t\t\t<key>OS_ACTIVITY_DT_MODE</key>
\t\t\t<string>YES</string>
\t\t\t<key>TERM</key>
\t\t\t<string>dumb</string>
\t\t</dict>
\t\t<key>IsUITestBundle</key>
\t\t<true/>
\t\t<key>CommandLineArguments</key>
\t\t<array/>
\t\t<key>DefaultTestExecutionTimeAllowance</key>
\t\t<integer>600</integer>
\t</dict>
\t<key>__xctestrun_metadata__</key>
\t<dict>
\t\t<key>FormatVersion</key>
\t\t<integer>1</integer>
\t</dict>
</dict>
</plist>`;

function expectDict(value: unknown): Map<string, unknown> {
  expect(value).toBeInstanceOf(Map);
  return value as Map<string, unknown>;
}

describe("XctestrunPlist", function () {
  describe("parsePlist / buildPlist round-trip (EC2)", function () {
    test("parses dicts as ordered Maps and preserves scalar types", async function () {
      const root = expectDict(await parsePlist(SAMPLE_XCTESTRUN));

      // Top-level key order preserved
      expect([...root.keys()]).toEqual([
        "CtrlProxyTests",
        "CtrlProxyUITests",
        "__xctestrun_metadata__",
      ]);

      const uiTarget = expectDict(root.get("CtrlProxyUITests"));
      expect(uiTarget.get("IsUITestBundle")).toBe(true);
      expect(uiTarget.get("DefaultTestExecutionTimeAllowance")).toBe(600);
      expect(uiTarget.get("CommandLineArguments")).toEqual([]);

      const metadata = expectDict(root.get("__xctestrun_metadata__"));
      expect(metadata.get("FormatVersion")).toBe(1);
    });

    test("round-trips losslessly through buildPlist -> parsePlist", async function () {
      const root = await parsePlist(SAMPLE_XCTESTRUN);
      const rebuilt = buildPlist(root);

      // Valid plist preamble
      expect(rebuilt).toContain("<!DOCTYPE plist PUBLIC");
      expect(rebuilt.trimStart().startsWith("<?xml")).toBe(true);

      const reparsed = expectDict(await parsePlist(rebuilt));
      const uiTarget = expectDict(reparsed.get("CtrlProxyUITests"));
      const env = expectDict(uiTarget.get("EnvironmentVariables"));
      expect([...env.entries()]).toEqual([
        ["OS_ACTIVITY_DT_MODE", "YES"],
        ["TERM", "dumb"],
      ]);
      expect(uiTarget.get("IsUITestBundle")).toBe(true);
    });

    test("escapes XML-special characters in string values", async function () {
      const root = new Map<string, unknown>([["weird", 'a & b < c > d "q"']]);
      const xml = buildPlist(root);
      expect(xml).toContain("a &amp; b &lt; c &gt; d");
      const reparsed = expectDict(await parsePlist(xml));
      expect(reparsed.get("weird")).toBe('a & b < c > d "q"');
    });
  });

  describe("injectUITestEnvironment (EC1)", function () {
    test("injects into UI-test target only, preserving existing entries", async function () {
      const root = expectDict(await parsePlist(SAMPLE_XCTESTRUN));
      const count = injectUITestEnvironment(root, {
        CTRL_PROXY_IOS_PORT: "8767",
        AUTOMOBILE_DEVICE_ID: "SIM-UUID",
      });

      expect(count).toBe(1);

      const uiEnv = expectDict(
        expectDict(root.get("CtrlProxyUITests")).get("EnvironmentVariables"),
      );
      // Existing entries preserved
      expect(uiEnv.get("OS_ACTIVITY_DT_MODE")).toBe("YES");
      expect(uiEnv.get("TERM")).toBe("dumb");
      // New entries injected
      expect(uiEnv.get("CTRL_PROXY_IOS_PORT")).toBe("8767");
      expect(uiEnv.get("AUTOMOBILE_DEVICE_ID")).toBe("SIM-UUID");

      // The non-UI (unit) target is left untouched
      const unitEnv = expectDict(
        expectDict(root.get("CtrlProxyTests")).get("EnvironmentVariables"),
      );
      expect(unitEnv.has("CTRL_PROXY_IOS_PORT")).toBe(false);
    });

    test("overwrites an existing key on the UI-test target", async function () {
      const root = expectDict(await parsePlist(SAMPLE_XCTESTRUN));
      injectUITestEnvironment(root, { TERM: "xterm" });
      const uiEnv = expectDict(
        expectDict(root.get("CtrlProxyUITests")).get("EnvironmentVariables"),
      );
      expect(uiEnv.get("TERM")).toBe("xterm");
    });

    test("creates EnvironmentVariables when the UI-test target lacks one", async function () {
      const root = new Map<string, unknown>([
        ["UITarget", new Map<string, unknown>([["IsUITestBundle", true]])],
      ]);
      const count = injectUITestEnvironment(root, { CTRL_PROXY_IOS_PORT: "9000" });
      expect(count).toBe(1);
      const env = expectDict(expectDict(root.get("UITarget")).get("EnvironmentVariables"));
      expect(env.get("CTRL_PROXY_IOS_PORT")).toBe("9000");
    });

    test("returns 0 when there is no UI-test bundle", async function () {
      const root = new Map<string, unknown>([
        ["UnitTarget", new Map<string, unknown>([["IsUITestBundle", false]])],
      ]);
      expect(injectUITestEnvironment(root, { X: "1" })).toBe(0);
    });
  });
});
