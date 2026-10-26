import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  parseAaptXmlTree,
  parseXmlResourceFiles,
} from "../../scripts/release/lib/artifact-policy/aaptXmlTree";
import { runAndroidGate, runIosGate } from "../../scripts/release/lib/artifact-policy/gate";
import { parseNmOutput } from "../../scripts/release/lib/artifact-policy/iosArtifactPolicy";
import {
  formatReport,
  parseArtifactPolicy,
  type ArtifactPolicy,
} from "../../scripts/release/lib/artifact-policy/policyData";
import type { ToolRunner } from "../../scripts/release/lib/artifact-policy/toolRunner";

const FIXTURES = fileURLToPath(
  new URL("../fixtures/protoviewer-artifact-policy/", import.meta.url),
);
const POLICY_FILE = fileURLToPath(
  new URL("../../scripts/release/protoviewer-artifact-policy.json", import.meta.url),
);

function fixture(relative: string): string {
  return readFileSync(`${FIXTURES}${relative}`, "utf8");
}

function loadPolicy(): ArtifactPolicy {
  return parseArtifactPolicy(readFileSync(POLICY_FILE, "utf8"));
}

/** Replays captured tool output by exact command line; anything else is a test bug. */
class ReplayRunner implements ToolRunner {
  readonly calls: string[] = [];
  constructor(private readonly outputs: Readonly<Record<string, string>>) {}

  async run(command: string, args: readonly string[], stdin?: string) {
    const key = [command, ...args].join(" ");
    this.calls.push(stdin === undefined ? key : `${key} <<< ${stdin.length} bytes`);
    const stdout = this.outputs[key];
    if (stdout === undefined) {
      throw new Error(`unexpected tool call: ${key}`);
    }
    return { stdout, stderr: "" };
  }
}

const APK = "app.apk";

function androidRunner(
  dir: string,
  edit: (manifest: string) => string = (manifest) => manifest,
  extra: Record<string, string> = {},
): ReplayRunner {
  return new ReplayRunner({
    [`aapt2 dump xmltree --file AndroidManifest.xml ${APK}`]: edit(
      fixture(`android/${dir}/manifest.xmltree.txt`),
    ),
    [`aapt2 dump resources ${APK}`]: fixture(`android/${dir}/xml-resources.txt`),
    ...extra,
  });
}

async function androidFailures(runner: ReplayRunner, allowSnapshotVersion = true) {
  const report = await runAndroidGate(
    { apkPath: APK, aapt2: "aapt2", allowSnapshotVersion },
    loadPolicy(),
    runner,
  );
  return report.failures;
}

const rules = (failures: readonly { rule: string }[]) => failures.map((failure) => failure.rule);

describe("aapt2 xmltree parser", () => {
  test("nests children by relative indent and keeps attributes on their element", () => {
    const manifest = parseAaptXmlTree(fixture("android/protoviewer-release/manifest.xmltree.txt"));
    expect(manifest.name).toBe("manifest");
    expect(manifest.attributes.package).toBe("dev.jasonpearson.automobile.protoviewer");
    const application = manifest.children.find((child) => child.name === "application");
    const activities = application?.children.filter((child) => child.name === "activity") ?? [];
    expect(activities.map((node) => node.attributes.name)).toContain(
      "dev.jasonpearson.automobile.protoviewer.ImportActivity",
    );
    const importActivity = activities.find((node) =>
      node.attributes.name?.endsWith("ImportActivity"),
    );
    expect(importActivity?.children.map((child) => child.name)).toEqual([
      "intent-filter",
      "intent-filter",
      "intent-filter",
    ]);
  });

  test("resolves xml resource ids to every config's file", () => {
    const files = parseXmlResourceFiles(fixture("android/control-proxy-release/xml-resources.txt"));
    expect(files.get("0x7f100003")).toEqual(["res/8G.xml"]);
    expect(files.get("0x7f100000")).toEqual(["res/-N.xml", "res/ge.xml", "res/Kq.xml"]);
  });
});

describe("Android artifact policy", () => {
  test("the real ProtoViewer release manifest conforms", async () => {
    expect(await androidFailures(androidRunner("protoviewer-release"))).toEqual([]);
  });

  test("a -SNAPSHOT versionName fails a release build but not a local one", async () => {
    const failures = await androidFailures(androidRunner("protoviewer-release"), false);
    expect(rules(failures)).toEqual(["android.versionName"]);
  });

  test("allowBackup=true fails", async () => {
    const runner = androidRunner("protoviewer-release", (manifest) =>
      manifest.replace(/allowBackup\(0x[0-9a-f]+\)=false/, "allowBackup(0x01010280)=true"),
    );
    expect(rules(await androidFailures(runner))).toEqual(["android.allowBackup"]);
  });

  test("an extra permission fails and names it", async () => {
    const runner = androidRunner("protoviewer-release", (manifest) =>
      manifest.replace(
        "      E: application",
        `      E: uses-permission (line=99)
        A: http://schemas.android.com/apk/res/android:name(0x01010003)="android.permission.READ_CONTACTS" (Raw: "android.permission.READ_CONTACTS")
      E: application`,
      ),
    );
    const failures = await androidFailures(runner);
    expect(rules(failures)).toEqual(["android.permissions"]);
    expect(failures[0].message).toContain("android.permission.READ_CONTACTS");
  });

  test("a missing allowlisted permission also fails (equality, not subset)", async () => {
    const runner = androidRunner("protoviewer-release", (manifest) =>
      manifest.replace(/ *E: uses-permission \(line=13\)\n.*\n/, ""),
    );
    const failures = await androidFailures(runner);
    expect(failures[0].message).toContain("missing: android.permission.ACCESS_LOCAL_NETWORK");
  });

  test("debuggable fails", async () => {
    const runner = androidRunner("protoviewer-release", (manifest) =>
      manifest.replace(
        "        A: http://schemas.android.com/apk/res/android:allowBackup",
        "        A: http://schemas.android.com/apk/res/android:debuggable(0x0101000f)=true\n        A: http://schemas.android.com/apk/res/android:allowBackup",
      ),
    );
    expect(rules(await androidFailures(runner))).toEqual(["android.debuggable"]);
  });

  test("an unprotected exported component fails, and a lost permission guard fails", async () => {
    const exportedProvider = androidRunner("protoviewer-release", (manifest) =>
      manifest.replace(/(FileProvider"[^\n]*\n[^\n]*exported\(0x[0-9a-f]+\))=false/, "$1=true"),
    );
    const failures = await androidFailures(exportedProvider);
    expect(failures[0].message).toContain("provider androidx.core.content.FileProvider");

    const unguarded = androidRunner("protoviewer-release", (manifest) =>
      manifest.replace(
        / *A: [^\n]*permission\(0x01010006\)="android.permission.DUMP"[^\n]*\n/g,
        "",
      ),
    );
    const messages = (await androidFailures(unguarded)).map((failure) => failure.message);
    expect(messages.some((message) => message.includes("McpActivity must be protected by"))).toBe(
      true,
    );
  });

  test("an absent exported attribute means exported only when an intent filter is declared", async () => {
    const dropExported = (activity: string) => (manifest: string) =>
      manifest.replace(
        new RegExp(
          `(${activity}" \\(Raw: "[^"]*"\\)\\n(?: *A: [^\\n]*\\n)*?) *A: [^\\n]*exported[^\\n]*\\n`,
        ),
        "$1",
      );
    // ImportActivity has intent filters: still exported, so still matches the allowlist.
    expect(
      await androidFailures(androidRunner("protoviewer-release", dropExported("ImportActivity"))),
    ).toEqual([]);
    // McpActivity has none: it becomes private, so the allowlisted entry is missing.
    const failures = await androidFailures(
      androidRunner("protoviewer-release", dropExported("McpActivity")),
    );
    expect(failures[0].message).toContain(
      "missing: activity dev.jasonpearson.automobile.protoviewer.McpActivity",
    );
  });

  test("a uses-permission-sdk-23 entry counts as a permission", async () => {
    const runner = androidRunner("protoviewer-release", (manifest) =>
      manifest.replace(
        "      E: application",
        `      E: uses-permission-sdk-23 (line=99)
        A: http://schemas.android.com/apk/res/android:name(0x01010003)="android.permission.CAMERA" (Raw: "android.permission.CAMERA")
      E: application`,
      ),
    );
    expect((await androidFailures(runner))[0].message).toContain("android.permission.CAMERA");
  });

  test("a boolean the policy cannot read fails closed instead of reading as false", async () => {
    const runner = androidRunner("protoviewer-release", (manifest) =>
      manifest.replace(/exported\(0x01010010\)=true/, "exported(0x01010010)=@0x7f050001"),
    );
    await expect(androidFailures(runner)).rejects.toThrow("not a literal boolean");
    await expect(
      androidFailures(
        androidRunner("protoviewer-release", (manifest) =>
          manifest.replace(/(A: [^\n]*exported\(0x01010010\))=true/, "$1 true"),
        ),
      ),
    ).rejects.toThrow("unparseable aapt2 xmltree attribute row");
  });

  test("an application-level permission protects components that declare none", async () => {
    const runner = androidRunner("protoviewer-release", (manifest) =>
      manifest
        .replace(/ *A: [^\n]*permission\(0x01010006\)="android.permission.DUMP"[^\n]*\n/g, "")
        .replace(
          "        A: http://schemas.android.com/apk/res/android:allowBackup",
          `        A: http://schemas.android.com/apk/res/android:permission(0x01010006)="android.permission.DUMP" (Raw: "android.permission.DUMP")
        A: http://schemas.android.com/apk/res/android:allowBackup`,
        ),
    );
    expect(await androidFailures(runner)).toEqual([]);
  });

  test("dataExtractionRules removal and a low targetSdk fail", async () => {
    const runner = androidRunner("protoviewer-release", (manifest) =>
      manifest
        .replace(/ *A: [^\n]*dataExtractionRules[^\n]*\n/, "")
        .replace(/targetSdkVersion\(0x01010270\)=37/, "targetSdkVersion(0x01010270)=35"),
    );
    expect(rules(await androidFailures(runner)).sort()).toEqual([
      "android.dataExtractionRules",
      "android.targetSdk",
    ]);
  });

  test("usesCleartextTraffic=true fails", async () => {
    const runner = androidRunner("protoviewer-release", (manifest) =>
      manifest.replace(
        /usesCleartextTraffic\(0x010104ec\)=false/,
        "usesCleartextTraffic(0x010104ec)=true",
      ),
    );
    expect(rules(await androidFailures(runner))).toEqual(["android.cleartext"]);
  });

  test("a cleartext network security config fails; an unresolvable one fails closed", async () => {
    const withConfig = (manifest: string) =>
      manifest.replace(
        "        A: http://schemas.android.com/apk/res/android:allowBackup",
        "        A: http://schemas.android.com/apk/res/android:networkSecurityConfig(0x01010527)=@0x7f100003\n        A: http://schemas.android.com/apk/res/android:allowBackup",
      );
    const resolved = androidRunner("protoviewer-release", withConfig, {
      [`aapt2 dump resources ${APK}`]: fixture("android/control-proxy-release/xml-resources.txt"),
      [`aapt2 dump xmltree --file res/8G.xml ${APK}`]: fixture(
        "android/control-proxy-release/network-security-config.xmltree.txt",
      ),
    });
    const failures = await androidFailures(resolved);
    expect(rules(failures)).toEqual(["android.cleartext"]);
    expect(failures[0].message).toContain("<base-config>");

    const unresolved = androidRunner("protoviewer-release", withConfig);
    expect((await androidFailures(unresolved))[0].message).toContain("did not resolve");
  });

  test("the real CtrlProxy release APK, the opposite posture, trips every Android rule", async () => {
    const runner = androidRunner("control-proxy-release", undefined, {
      [`aapt2 dump xmltree --file res/8G.xml ${APK}`]: fixture(
        "android/control-proxy-release/network-security-config.xmltree.txt",
      ),
    });
    expect([...new Set(rules(await androidFailures(runner)))].sort()).toEqual([
      "android.allowBackup",
      "android.applicationId",
      "android.cleartext",
      "android.dataExtractionRules",
      "android.declaredPermissions",
      "android.exportedComponents",
      "android.permissions",
    ]);
  });
});

const APP = "ProtoViewer.app";
const INFO_ARGS = `plutil -convert json -o - ${APP}/Info.plist`;
const ENTITLEMENTS_ARGS = `codesign -d --entitlements :- ${APP}`;
const NM_ARGS = `nm -a ${APP}/ProtoViewer`;

function iosRunner(options: {
  info?: string;
  entitlements?: string;
  nm?: string;
  entitlementsJson?: string;
}): ReplayRunner {
  return new ReplayRunner({
    [INFO_ARGS]: options.info ?? fixture("ios/simulator-app/info-plist.json"),
    [ENTITLEMENTS_ARGS]:
      options.entitlements ?? fixture("ios/simulator-app/codesign-entitlements.txt"),
    [NM_ARGS]: options.nm ?? fixture("ios/simulator-app/nm-a.txt"),
    "plutil -convert json -o - -": options.entitlementsJson ?? "{}",
  });
}

const BUNDLE = ["Info.plist", "ProtoViewer", "_CodeSignature", "en.lproj"];

async function iosReport(
  runner: ReplayRunner,
  options: {
    platform?: "iPhoneOS" | "iPhoneSimulator";
    policy?: ArtifactPolicy;
    bundle?: string[];
  } = {},
) {
  return runIosGate(
    {
      appPath: APP,
      platform: options.platform ?? "iPhoneSimulator",
      files: { list: () => options.bundle ?? BUNDLE },
    },
    options.policy ?? loadPolicy(),
    runner,
  );
}

describe("iOS artifact policy", () => {
  test("the real simulator build passes with the two not-yet-landed rules as warnings", async () => {
    const report = await iosReport(iosRunner({}));
    expect(report.failures).toEqual([]);
    expect(report.warnings.map((warning) => [warning.rule, warning.pendingIssue])).toEqual([
      ["ios.forbiddenSymbols", "#14150"],
      ["ios.privacyManifest", "#14151"],
    ]);
  });

  test("once the advisory table is emptied, the same build fails on those two rules", async () => {
    const policy = { ...loadPolicy(), advisory: {} };
    const report = await iosReport(iosRunner({}), { policy });
    expect(rules(report.failures)).toEqual(["ios.forbiddenSymbols", "ios.privacyManifest"]);
  });

  test("a device ipa must say iPhoneOS", async () => {
    const report = await iosReport(iosRunner({}), { platform: "iPhoneOS" });
    expect(rules(report.failures)).toEqual(["ios.platform"]);
  });

  test("an ATS exception fails", async () => {
    const report = await iosReport(
      iosRunner({ info: fixture("ios/ats-exception/info-plist.json") }),
    );
    expect(rules(report.failures)).toEqual(["ios.ats"]);
    expect(report.failures[0].message).toContain("NSAppTransportSecurity.NSAllowsArbitraryLoads");
  });

  test("file sharing and a foreign bundle identifier fail", async () => {
    const info = JSON.stringify({
      ...JSON.parse(fixture("ios/simulator-app/info-plist.json")),
      UIFileSharingEnabled: true,
      CFBundleIdentifier: "dev.example.other",
    });
    const report = await iosReport(iosRunner({ info }));
    expect(rules(report.failures).sort()).toEqual(["ios.bundleIdentifier", "ios.infoPlist"]);
  });

  test("get-task-allow and other entitlements outside the allowlist fail", async () => {
    const entitlements = fixture("ios/dev-signed/codesign-entitlements.txt");
    const runner = iosRunner({
      entitlements,
      entitlementsJson: '{"get-task-allow":true,"com.apple.developer.networking.wifi-info":true}',
    });
    const report = await iosReport(runner);
    expect(report.failures.map((failure) => failure.message)).toEqual([
      "forbidden entitlements present: get-task-allow",
      "entitlements outside the allowlist: com.apple.developer.networking.wifi-info",
    ]);
    expect(runner.calls).toContain(`plutil -convert json -o - - <<< ${entitlements.length} bytes`);
  });

  test("a distribution profile that states get-task-allow as false passes", async () => {
    const report = await iosReport(
      iosRunner({
        entitlements: "<plist/>",
        entitlementsJson: '{"get-task-allow":false,"beta-reports-active":true}',
      }),
    );
    expect(report.failures).toEqual([]);
  });

  test("allowlisted store entitlements pass", async () => {
    const report = await iosReport(
      iosRunner({
        entitlements: "<plist/>",
        entitlementsJson:
          '{"application-identifier":"T.dev","com.apple.developer.team-identifier":"T"}',
      }),
    );
    expect(report.failures).toEqual([]);
  });

  test("a debug map in the executable and a shipped dSYM fail", async () => {
    const runner = iosRunner({ nm: fixture("ios/debug-info/nm-a.txt") });
    const report = await iosReport(runner, {
      bundle: [...BUNDLE, "ProtoViewer.app.dSYM/Contents"],
    });
    expect(rules(report.failures)).toEqual(["ios.debugInfo", "ios.debugInfo"]);
  });

  test("a bundle with the privacy manifest and no forbidden symbols is warning-free", async () => {
    const nm = parseNmOutput(fixture("ios/simulator-app/nm-a.txt"));
    expect(nm.debugStabs).toBe(0);
    const cleanNm = fixture("ios/simulator-app/nm-a.txt")
      .split("\n")
      .filter((line) => !line.includes("PrototypeServer"))
      .join("\n");
    const report = await iosReport(iosRunner({ nm: cleanNm }), {
      bundle: [...BUNDLE, "PrivacyInfo.xcprivacy"],
    });
    expect(report.failures).toEqual([]);
    expect(report.warnings).toEqual([]);
  });
});

describe("policy data and report", () => {
  test("every advisory rule is a rule the evaluators can emit", () => {
    const known = ["ios.forbiddenSymbols", "ios.privacyManifest"];
    expect(Object.keys(loadPolicy().advisory).every((rule) => known.includes(rule))).toBe(true);
  });

  test("formatReport states the verdict, failures and advisory warnings", async () => {
    const report = await iosReport(iosRunner({}), { platform: "iPhoneOS" });
    const text = formatReport("ProtoViewer.app", report);
    expect(text).toContain("FAILED: ProtoViewer.app");
    expect(text).toContain("FAIL [ios.platform]");
    expect(text).toContain("WARN [ios.privacyManifest]");
    expect(text).toContain("advisory until #14151");
  });
});
