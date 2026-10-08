import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { load } from "js-yaml";
import { parseIosUserDefaultsPlist } from "../../src/features/preferences/IosUserDefaultsPlist";
import {
  NETWORK_FILTER_IDENTITY,
  PROFILE_PATH,
  buildProfile,
  designatedRequirement,
  escapeXmlText,
  renderProfile,
  serializePlist,
} from "../../scripts/network-filter/generate-mdm-profile";

const repoFile = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));

async function plistString(path: string, key: string): Promise<unknown> {
  const parsed = await parseIosUserDefaultsPlist(readFileSync(repoFile(path), "utf8"));
  return parsed.get(key)?.value;
}

describe("network-filter MDM profile", () => {
  test("the committed profile equals the generator output byte for byte", () => {
    expect(readFileSync(PROFILE_PATH, "utf8")).toBe(renderProfile());
  });

  test("pins the stable designated requirement with no version or cdhash", () => {
    const { teamId, extensionBundleId } = NETWORK_FILTER_IDENTITY;
    const requirement = designatedRequirement(extensionBundleId, teamId);
    expect(requirement).toBe(
      'anchor apple generic and identifier "dev.jasonpearson.automobile.networkfilter.provider" and certificate leaf[subject.OU] = "CEZH89E7MT"',
    );
    const profile = readFileSync(PROFILE_PATH, "utf8");
    expect(profile).toContain(`<string>${requirement}</string>`);
    // Nothing release-specific: no cdhash or bundle version in the requirement
    // or anywhere else in the profile, and no x.y.z release number.
    expect(requirement).not.toMatch(/cdhash|version/i);
    expect(profile).not.toMatch(/cdhash|CFBundleVersion|CFBundleShortVersionString/i);
    expect(profile).not.toMatch(/\b\d+\.\d+\.\d+\b/);
  });

  test("round-trips through a plist parser with the expected payloads", async () => {
    const parsed = await parseIosUserDefaultsPlist(renderProfile());
    expect(parsed.get("PayloadType")?.value).toBe("Configuration");
    expect(parsed.get("PayloadScope")?.value).toBe("System");
    const payloads = JSON.parse(String(parsed.get("PayloadContent")?.value));
    expect(payloads).toEqual([
      expect.objectContaining({
        PayloadType: "com.apple.system-extension-policy",
        AllowedSystemExtensions: {
          CEZH89E7MT: ["dev.jasonpearson.automobile.networkfilter.provider"],
        },
        AllowedSystemExtensionTypes: { CEZH89E7MT: ["NetworkExtension"] },
      }),
      expect.objectContaining({
        PayloadType: "com.apple.webcontent-filter",
        FilterType: "Plugin",
        PluginBundleID: "dev.jasonpearson.automobile.networkfilter",
        FilterDataProviderBundleIdentifier: "dev.jasonpearson.automobile.networkfilter.provider",
        FilterSockets: true,
        FilterPackets: false,
        UserDefinedName: "AutoMobile Network Filter",
      }),
    ]);
  });

  test("identifiers match the packaged bundles and the release signing team", async () => {
    expect(
      await plistString("ios/network-filter/Packaging/Controller-Info.plist", "CFBundleIdentifier"),
    ).toBe(NETWORK_FILTER_IDENTITY.containingAppBundleId);
    expect(
      await plistString("ios/network-filter/Packaging/Provider-Info.plist", "CFBundleIdentifier"),
    ).toBe(NETWORK_FILTER_IDENTITY.extensionBundleId);
    const workflow = load(
      readFileSync(repoFile(".github/workflows/build-network-filter-probe.yml"), "utf8"),
    ) as { jobs: { build: { steps: Array<{ env?: Record<string, string> }> } } };
    const teams = workflow.jobs.build.steps.flatMap((step) =>
      step.env?.MACOS_DEVELOPER_ID_TEAM_ID ? [step.env.MACOS_DEVELOPER_ID_TEAM_ID] : [],
    );
    expect(teams).toEqual([NETWORK_FILTER_IDENTITY.teamId]);
  });

  test("rejects identities that would produce an invalid requirement", () => {
    expect(() => buildProfile({ ...NETWORK_FILTER_IDENTITY, teamId: "short" })).toThrow("Team ID");
    expect(() =>
      buildProfile({ ...NETWORK_FILTER_IDENTITY, extensionBundleId: 'x" or anchor apple' }),
    ).toThrow("bundle identifier");
  });
});

describe("serializePlist", () => {
  test("escapes markup characters in keys and strings", () => {
    expect(escapeXmlText('a & <b> "c"')).toBe('a &amp; &lt;b&gt; "c"');
    const xml = serializePlist({ "k<&>": "v<&>" });
    expect(xml).toContain("<key>k&lt;&amp;&gt;</key>");
    expect(xml).toContain("<string>v&lt;&amp;&gt;</string>");
  });

  test("rejects characters XML 1.0 cannot carry and non-integer numbers", () => {
    expect(() => serializePlist("bell\u0007")).toThrow("XML 1.0");
    expect(() => serializePlist(1.5)).toThrow("safe integers");
  });

  test("sorts dictionary keys and renders empty containers self-closed", () => {
    expect(serializePlist({ b: [], a: {} })).toContain(
      "<dict>\n\t<key>a</key>\n\t<dict/>\n\t<key>b</key>\n\t<array/>\n</dict>",
    );
  });
});
