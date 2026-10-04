import { describe, expect, test } from "bun:test";
import {
  parsePlist,
  buildPlist,
  injectUITestEnvironment,
  PlistReal,
  type PlistValue,
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

/**
 * A minimal format-version-2 xctestrun: the layout `xcodebuild` emits when
 * the scheme resolves a test plan. The UI-test target lives nested under
 * `TestConfigurations[].TestTargets[]` instead of at the top level.
 */
const SAMPLE_XCTESTRUN_V2 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>TestConfigurations</key>
\t<array>
\t\t<dict>
\t\t\t<key>Name</key>
\t\t\t<string>Configuration 1</string>
\t\t\t<key>TestTargets</key>
\t\t\t<array>
\t\t\t\t<dict>
\t\t\t\t\t<key>BlueprintName</key>
\t\t\t\t\t<string>CtrlProxyUITests</string>
\t\t\t\t\t<key>IsUITestBundle</key>
\t\t\t\t\t<true/>
\t\t\t\t\t<key>EnvironmentVariables</key>
\t\t\t\t\t<dict>
\t\t\t\t\t\t<key>TERM</key>
\t\t\t\t\t\t<string>dumb</string>
\t\t\t\t\t</dict>
\t\t\t\t</dict>
\t\t\t</array>
\t\t</dict>
\t</array>
\t<key>__xctestrun_metadata__</key>
\t<dict>
\t\t<key>FormatVersion</key>
\t\t<integer>2</integer>
\t</dict>
</dict>
</plist>`;

function expectDict(value: unknown): Map<string, unknown> {
  expect(value).toBeInstanceOf(Map);
  return value as Map<string, unknown>;
}

describe("XctestrunPlist", function () {
  describe("parsePlist / buildPlist round-trip (EC2)", function () {
    test("preserves absent values and malformed dictionary pair tolerance in the existing capture", async () => {
      const missingValue = SAMPLE_XCTESTRUN.replace("<integer>1</integer>", "");
      const root = expectDict(await parsePlist(missingValue));
      expect(expectDict(root.get("__xctestrun_metadata__")).get("FormatVersion")).toBe("");

      const nonKey = SAMPLE_XCTESTRUN.replace(
        "<key>FormatVersion</key>",
        "<string>FormatVersion</string>",
      );
      const skipped = expectDict(await parsePlist(nonKey));
      expect([...expectDict(skipped.get("__xctestrun_metadata__")).entries()]).toEqual([]);

      const unknownValue = SAMPLE_XCTESTRUN.replace("<integer>1</integer>", "<unknown>1</unknown>");
      const fallback = expectDict(await parsePlist(unknownValue));
      expect(expectDict(fallback.get("__xctestrun_metadata__")).get("FormatVersion")).toBe("1");
    });

    test("preserves empty scalar defaults using the existing capture", async () => {
      for (const [tag, expected] of [
        ["string", ""],
        ["integer", 0],
        ["real", new PlistReal(0)],
        ["data", Buffer.alloc(0)],
        ["date", new Date(0)],
        ["true", true],
        ["false", false],
        ["unknown", ""],
      ] as const) {
        const root = expectDict(
          await parsePlist(SAMPLE_XCTESTRUN.replace("<integer>1</integer>", `<${tag}/>`)),
        );
        expect(expectDict(root.get("__xctestrun_metadata__")).get("FormatVersion")).toEqual(
          expected,
        );
      }
    });

    test("preserves exact collection and scalar serialization", () => {
      const value: PlistValue = new Map<string, PlistValue>([
        ["emptyDict", new Map()],
        ["emptyArray", []],
        [
          "values",
          [
            true,
            false,
            new PlistReal(30),
            1,
            1.5,
            new Date("2026-01-01T00:00:00.123Z"),
            Buffer.from("binary xctestrun payload"),
            "a & b < c > d",
          ],
        ],
      ]);
      expect(buildPlist(value).split("\n").slice(3, -2)).toEqual([
        "<dict>",
        "\t<key>emptyDict</key>",
        "\t<dict/>",
        "\t<key>emptyArray</key>",
        "\t<array/>",
        "\t<key>values</key>",
        "\t<array>",
        "\t\t<true/>",
        "\t\t<false/>",
        "\t\t<real>30</real>",
        "\t\t<integer>1</integer>",
        "\t\t<real>1.5</real>",
        "\t\t<date>2026-01-01T00:00:00Z</date>",
        "\t\t<data>YmluYXJ5IHhjdGVzdHJ1biBwYXlsb2Fk</data>",
        "\t\t<string>a &amp; b &lt; c &gt; d</string>",
        "\t</array>",
        "</dict>",
      ]);
    });

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

    test("round-trips a <data> value as a Buffer, not a <string> (issue #6372)", async function () {
      const payload = Buffer.from("binary xctestrun payload", "utf-8");
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>SomeHash</key>
\t<data>${payload.toString("base64")}</data>
</dict>
</plist>`;

      const root = expectDict(await parsePlist(xml));
      const parsedValue = root.get("SomeHash");
      expect(Buffer.isBuffer(parsedValue)).toBe(true);
      expect((parsedValue as Buffer).equals(payload)).toBe(true);

      const rebuilt = buildPlist(root);
      expect(rebuilt).toContain(`<data>${payload.toString("base64")}</data>`);
      expect(rebuilt).not.toContain("<string>");

      const reparsed = expectDict(await parsePlist(rebuilt));
      const reparsedValue = reparsed.get("SomeHash");
      expect(Buffer.isBuffer(reparsedValue)).toBe(true);
      expect((reparsedValue as Buffer).equals(payload)).toBe(true);
    });

    test("round-trips an integral <real> value as <real>, not <integer> (issue #6372)", async function () {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>TestTimeoutSeconds</key>
\t<real>30</real>
</dict>
</plist>`;

      const root = expectDict(await parsePlist(xml));
      const rebuilt = buildPlist(root);
      expect(rebuilt).toContain("<real>30</real>");
      expect(rebuilt).not.toContain("<integer>30</integer>");

      const reparsed = expectDict(await parsePlist(rebuilt));
      const reparsedXml = buildPlist(reparsed);
      expect(reparsedXml).toContain("<real>30</real>");
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

    test("injects into a FormatVersion 2 (TestConfigurations[].TestTargets[]) UI-test target", async function () {
      const root = expectDict(await parsePlist(SAMPLE_XCTESTRUN_V2));
      const count = injectUITestEnvironment(root, {
        CTRL_PROXY_IOS_PORT: "8767",
        AUTOMOBILE_DEVICE_ID: "SIM-UUID",
      });

      expect(count).toBe(1);

      const configurations = root.get("TestConfigurations") as unknown[];
      const configuration = expectDict(configurations[0]);
      const testTargets = configuration.get("TestTargets") as unknown[];
      const uiTarget = expectDict(testTargets[0]);
      const uiEnv = expectDict(uiTarget.get("EnvironmentVariables"));

      // Existing entry preserved.
      expect(uiEnv.get("TERM")).toBe("dumb");
      // New entries injected.
      expect(uiEnv.get("CTRL_PROXY_IOS_PORT")).toBe("8767");
      expect(uiEnv.get("AUTOMOBILE_DEVICE_ID")).toBe("SIM-UUID");
    });

    test("injected environment survives a buildPlist -> parsePlist round-trip at the nested v2 location", async function () {
      const root = expectDict(await parsePlist(SAMPLE_XCTESTRUN_V2));
      injectUITestEnvironment(root, { CTRL_PROXY_IOS_PORT: "8767" });
      const rebuilt = buildPlist(root);

      const reparsed = expectDict(await parsePlist(rebuilt));
      const configurations = reparsed.get("TestConfigurations") as unknown[];
      const configuration = expectDict(configurations[0]);
      const testTargets = configuration.get("TestTargets") as unknown[];
      const uiTarget = expectDict(testTargets[0]);
      const uiEnv = expectDict(uiTarget.get("EnvironmentVariables"));

      expect(uiEnv.get("CTRL_PROXY_IOS_PORT")).toBe("8767");
      expect(uiEnv.get("TERM")).toBe("dumb");
    });

    test("returns 0 for a v2-shaped file with no UI-test target in either layout", async function () {
      const root = expectDict(
        await parsePlist(
          [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<plist version="1.0">',
            "<dict>",
            "\t<key>TestConfigurations</key>",
            "\t<array>",
            "\t\t<dict>",
            "\t\t\t<key>TestTargets</key>",
            "\t\t\t<array>",
            "\t\t\t\t<dict><key>IsUITestBundle</key><false/></dict>",
            "\t\t\t</array>",
            "\t\t</dict>",
            "\t</array>",
            "</dict>",
            "</plist>",
          ].join("\n"),
        ),
      );
      expect(injectUITestEnvironment(root, { X: "1" })).toBe(0);
    });
  });
});
