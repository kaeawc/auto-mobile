import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, X509Certificate } from "crypto";
import { join, resolve } from "path";
import { XcodeSigningManager } from "../../../src/utils/ios-cmdline-tools/XcodeSigning";
import { DAEMON_LAUNCH_CWD_ENV } from "../../../src/utils/workingDirectory";
import { FakeTimer } from "../../fakes/FakeTimer";

const CERT_BASE64 =
  "MIIDETCCAfmgAwIBAgIUJQItJgRhsTPNGV58eJPhAw9xIWcwDQYJKoZIhvcNAQELBQAwGDEWMBQGA1UEAwwNVGVzdCBEZXYgQ2VydDAeFw0yNjAxMTgxOTE5MzVaFw0yNzAxMTgxOTE5MzVaMBgxFjAUBgNVBAMMDVRlc3QgRGV2IENlcnQwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDCXt1bEnb5HFGXYeCDJfGUK6A84+6ZowKRvfP4F9XmLn24Pp0bvd0sam7Ayp6rFMkRcCUJ0FmcEUV/JbW30uGmFlrCQG4k4Rved/xrXIYZK1ny2Z5hH0AG13JiStLIqUTARgx1NDnlQl18b5R8OjeXeWD79x/RFrNUyIinW2fnv3jzF8jjme6P3f8pK+TJmLIZQGpNQT+FApApOnND2AEh+RhjnJi3AIDXIpBo8dFhXmOqfE5mtb5gzIyKPrc15l74kW8ndxFoVjJtMinzjbYIsI6t4wOkTJn0hZYDwWHwBfx622cK35zxcGok16EbCdJlfdGxNseeUxWAJoki+MaZAgMBAAGjUzBRMB0GA1UdDgQWBBR4aCibWRc1OiPPqD0CqjTneWJcnTAfBgNVHSMEGDAWgBR4aCibWRc1OiPPqD0CqjTneWJcnTAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQAXZsPO3k4url4xeggh0AHjZHH4/FQUKPlrKH1+icN/PrPDqc3ubiuLynTN6oHYMM6bHF1i7/fjTXfwtSH4Y28YnLNA/5Yywz+A2PAr0VlMFDGNn9clM5AiZUrpwhOzRIC2opiSgUBVXcHJr9DlCo227ZaM4EmWlFPwyY6LNUyPfqECwFKmDgtuzSqICOGyJy2s1MGXUiWqeyyJgRe1ZdLhNaC3+3/I/0YBm6TYP8anir7vYZCyCDDEtOlNdv9+qQHtoym1f02VRpntDF+k5qiHPICFDVwHCaSXIoghyEqD3y9HH9GWiGKze3mXB7xofhGUL9ATLpRWrzxHSGVS6shr";

const deviceUdid = "00008030001E28C11E";
const profileUuid = "A0B1C2D3-E4F5-6789-ABCD-EF0123456789";
const profileName = "AutoMobile CtrlProxy";
const teamId = "TEAM12345";

const profileXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>UUID</key>
    <string>${profileUuid}</string>
    <key>Name</key>
    <string>${profileName}</string>
    <key>TeamIdentifier</key>
    <array>
      <string>${teamId}</string>
    </array>
    <key>TeamName</key>
    <string>AutoMobile Team</string>
    <key>CreationDate</key>
    <date>2024-01-01T00:00:00Z</date>
    <key>ExpirationDate</key>
    <date>2030-01-01T00:00:00Z</date>
    <key>ProvisionsAllDevices</key>
    <false/>
    <key>ProvisionedDevices</key>
    <array>
      <string>${deviceUdid}</string>
    </array>
    <key>Entitlements</key>
    <dict>
      <key>get-task-allow</key>
      <true/>
      <key>application-identifier</key>
      <string>${teamId}.dev.jasonpearson.automobile.ctrlproxy</string>
    </dict>
    <key>DeveloperCertificates</key>
    <array>
      <data>${CERT_BASE64}</data>
    </array>
  </dict>
</plist>`;

const buildFingerprint = (certBase64: string): string => {
  const raw = Buffer.from(certBase64, "base64");
  const cert = new X509Certificate(raw);
  return createHash("sha256").update(cert.raw).digest("hex").toUpperCase();
};

const createFakeDependencies = (options?: { identities?: string; profiles?: string[] }) => {
  const fakeTimer = new FakeTimer();
  fakeTimer.enableAutoAdvance();
  const writtenFiles: string[] = [];
  const xcodebuildArgs: string[][] = [];
  return {
    deps: {
      platform: () => "darwin" as const,
      securityClient: {
        getDiagnostics: async () => ({ available: true, version: null }),
        listCodeSigningIdentities: async () => {
          const output = options?.identities ?? "";
          const match = output.match(/^\s*\d+\)\s+([0-9A-F]{40,64})\s+"([^\"]+)"/im);
          return match ? [{ fingerprint: match[1].toUpperCase(), name: match[2] }] : [];
        },
        decodeCms: async () => profileXml,
      },
      xcodebuild: {
        executeCommand: async (args: string[]) => {
          xcodebuildArgs.push([...args]);
          if (args.includes("-showBuildSettings")) {
            return {
              stdout: `DEVELOPMENT_TEAM = ${teamId}`,
              stderr: "",
              toString() {
                return this.stdout;
              },
              trim() {
                return this.stdout.trim();
              },
              includes(searchString: string) {
                return this.stdout.includes(searchString);
              },
            };
          }
          return {
            stdout: "",
            stderr: "",
            toString() {
              return this.stdout;
            },
            trim() {
              return this.stdout.trim();
            },
            includes(searchString: string) {
              return this.stdout.includes(searchString);
            },
          };
        },
        isAvailable: async () => true,
      },
      readDir: async () => options?.profiles ?? ["test.mobileprovision"],
      readFile: async () => "",
      stat: async () => ({ isFile: () => true }),
      writeFile: async (path: string) => {
        writtenFiles.push(path);
      },
      mkdir: async () => {},
      homedir: () => "/Users/test",
      now: () => fakeTimer.now(),
    },
    writtenFiles,
    xcodebuildArgs,
  };
};

// ADD-4 (#4177 item 5): profile-eligibility table. `resolveSigningForDevice`
// reads the PREFERRED profile from the env var AUTOMOBILE_IOS_PROFILE_UUID (it
// takes exactly one param, the device udid — there is no options arg). Fixed
// `now` (mid-2026, inside the CERT validity window) so expiry rows are
// deterministic rather than host-clock-dependent.
const ELIGIBILITY_NOW = Date.parse("2026-06-01T00:00:00Z");

interface ProfileSpec {
  uuid: string;
  name: string;
  expiration: string; // ISO date
  provisionsAllDevices?: boolean;
  provisionedDevices?: string[] | null;
  getTaskAllow?: boolean;
  includeMatchingCert?: boolean;
}

const makeProfileXml = (spec: ProfileSpec): string => {
  const devicesBlock = spec.provisionedDevices
    ? `<key>ProvisionedDevices</key>\n<array>${spec.provisionedDevices.map((d) => `<string>${d}</string>`).join("")}</array>`
    : "";
  const certBlock = spec.includeMatchingCert
    ? `<key>DeveloperCertificates</key>\n<array><data>${CERT_BASE64}</data></array>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
  <dict>
    <key>UUID</key><string>${spec.uuid}</string>
    <key>Name</key><string>${spec.name}</string>
    <key>TeamIdentifier</key><array><string>${teamId}</string></array>
    <key>TeamName</key><string>AutoMobile Team</string>
    <key>CreationDate</key><date>2024-01-01T00:00:00Z</date>
    <key>ExpirationDate</key><date>${spec.expiration}</date>
    <key>ProvisionsAllDevices</key><${spec.provisionsAllDevices ? "true" : "false"}/>
    ${devicesBlock}
    <key>Entitlements</key>
    <dict>
      <key>get-task-allow</key><${spec.getTaskAllow ? "true" : "false"}/>
      <key>application-identifier</key><string>${teamId}.dev.jasonpearson.automobile.ctrlproxy</string>
    </dict>
    ${certBlock}
  </dict>
</plist>`;
};

const createEligibilityDependencies = (specs: ProfileSpec[]) => {
  const fingerprint = buildFingerprint(CERT_BASE64);
  const byFile = new Map<string, string>();
  const fileNames: string[] = [];
  for (const spec of specs) {
    const fileName = `${spec.uuid}.mobileprovision`;
    fileNames.push(fileName);
    byFile.set(fileName, makeProfileXml(spec));
  }
  return {
    platform: () => "darwin" as const,
    securityClient: {
      getDiagnostics: async () => ({ available: true, version: null }),
      listCodeSigningIdentities: async () => [
        { fingerprint, name: `Apple Development: Test (${teamId})` },
      ],
      // decodeCms is called with the full profile path; key on the file name.
      decodeCms: async (path: string) => {
        const match = [...byFile.keys()].find((name) => path.includes(name));
        return match ? byFile.get(match)! : "";
      },
    },
    xcodebuild: {
      executeCommand: async () => ({
        stdout: "",
        stderr: "",
        toString() {
          return this.stdout;
        },
        trim() {
          return this.stdout.trim();
        },
        includes(s: string) {
          return this.stdout.includes(s);
        },
      }),
      isAvailable: async () => true,
    },
    readDir: async () => fileNames,
    readFile: async () => "",
    stat: async () => ({ isFile: () => true }),
    writeFile: async () => {},
    mkdir: async () => {},
    homedir: () => "/Users/test",
    now: () => ELIGIBILITY_NOW,
  };
};

describe("XcodeSigningManager profile eligibility (env-selected preferred profile)", () => {
  const SIGNING_ENV_VARS = [
    "AUTOMOBILE_IOS_TEAM_IDS",
    "AUTOMOBILE_IOS_TEAM_ID",
    "AUTOMOBILE_IOS_PROFILE_UUID",
    "AUTOMOBILE_IOS_PROFILE_NAME",
    "AUTOMOBILE_IOS_PROFILE_SPECIFIER",
    "AUTOMOBILE_IOS_CODE_SIGN_IDENTITY",
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of SIGNING_ENV_VARS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of SIGNING_ENV_VARS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  const otherDevice = "00008030FFFFFFFFFF";

  test("selects a valid device-included development profile named via env (manual, no expiry/device warning)", async () => {
    const uuid = "11111111-1111-1111-1111-111111111111";
    process.env.AUTOMOBILE_IOS_PROFILE_UUID = uuid;
    const manager = new XcodeSigningManager(
      createEligibilityDependencies([
        {
          uuid,
          name: "Valid Dev",
          expiration: "2030-01-01T00:00:00Z",
          provisionedDevices: [deviceUdid],
          getTaskAllow: true,
          includeMatchingCert: true,
        },
      ]),
    );

    const resolution = await manager.resolveSigningForDevice(deviceUdid);

    expect(resolution.style).toBe("manual");
    expect(resolution.profile?.uuid).toBe(uuid);
    expect(resolution.warnings.some((w) => w.includes("expired"))).toBe(false);
    expect(resolution.warnings.some((w) => w.includes("does not include device"))).toBe(false);
  });

  test("warns when the env-selected profile is expired", async () => {
    const uuid = "22222222-2222-2222-2222-222222222222";
    process.env.AUTOMOBILE_IOS_PROFILE_UUID = uuid;
    const manager = new XcodeSigningManager(
      createEligibilityDependencies([
        {
          uuid,
          name: "Expired Dev",
          expiration: "2020-01-01T00:00:00Z",
          provisionedDevices: [deviceUdid],
          getTaskAllow: true,
          includeMatchingCert: true,
        },
      ]),
    );

    const resolution = await manager.resolveSigningForDevice(deviceUdid);

    expect(
      resolution.warnings.some((w) => w.includes("Expired Dev") && w.includes("expired")),
    ).toBe(true);
  });

  test("warns when the env-selected profile does not provision the target device", async () => {
    const uuid = "33333333-3333-3333-3333-333333333333";
    process.env.AUTOMOBILE_IOS_PROFILE_UUID = uuid;
    const manager = new XcodeSigningManager(
      createEligibilityDependencies([
        {
          uuid,
          name: "Wrong Device",
          expiration: "2030-01-01T00:00:00Z",
          provisionedDevices: [otherDevice],
          getTaskAllow: true,
          includeMatchingCert: true,
        },
      ]),
    );

    const resolution = await manager.resolveSigningForDevice(deviceUdid);

    expect(
      resolution.warnings.some(
        (w) => w.includes("does not include device") && w.includes(deviceUdid),
      ),
    ).toBe(true);
  });

  test("warns when the env-requested profile UUID is not present", async () => {
    process.env.AUTOMOBILE_IOS_PROFILE_UUID = "99999999-0000-0000-0000-000000000000";
    const manager = new XcodeSigningManager(
      createEligibilityDependencies([
        {
          uuid: "44444444-4444-4444-4444-444444444444",
          name: "Some Dev",
          expiration: "2030-01-01T00:00:00Z",
          provisionedDevices: [deviceUdid],
          getTaskAllow: true,
          includeMatchingCert: true,
        },
      ]),
    );

    const resolution = await manager.resolveSigningForDevice(deviceUdid);

    expect(
      resolution.warnings.some(
        (w) => w.includes("99999999-0000-0000-0000-000000000000") && w.includes("not found"),
      ),
    ).toBe(true);
  });

  test("with no preferred profile, prefers development over enterprise/ad-hoc (development-first ordering)", async () => {
    // All three are eligible (not expired, device-included or all-devices) and
    // carry the matching cert, so whichever is selected resolves to manual. The
    // ordering contract must pick the development profile.
    const devUuid = "aaaaaaaa-0000-0000-0000-000000000000";
    const manager = new XcodeSigningManager(
      createEligibilityDependencies([
        {
          uuid: "cccccccc-0000-0000-0000-000000000000",
          name: "Enterprise",
          expiration: "2030-01-01T00:00:00Z",
          provisionsAllDevices: true,
          includeMatchingCert: true,
        },
        {
          uuid: "bbbbbbbb-0000-0000-0000-000000000000",
          name: "AdHoc",
          expiration: "2030-01-01T00:00:00Z",
          provisionedDevices: [deviceUdid],
          getTaskAllow: false,
          includeMatchingCert: true,
        },
        {
          uuid: devUuid,
          name: "Development",
          expiration: "2030-01-01T00:00:00Z",
          provisionedDevices: [deviceUdid],
          getTaskAllow: true,
          includeMatchingCert: true,
        },
      ]),
    );

    const resolution = await manager.resolveSigningForDevice(deviceUdid);

    expect(resolution.profile?.profileType).toBe("development");
    expect(resolution.profile?.uuid).toBe(devUuid);
  });
});

describe("XcodeSigningManager", () => {
  const originalLaunchCwd = process.env[DAEMON_LAUNCH_CWD_ENV];

  afterEach(() => {
    if (originalLaunchCwd === undefined) {
      delete process.env[DAEMON_LAUNCH_CWD_ENV];
    } else {
      process.env[DAEMON_LAUNCH_CWD_ENV] = originalLaunchCwd;
    }
  });

  test("selects manual signing when a matching profile and identity exist", async () => {
    const fingerprint = buildFingerprint(CERT_BASE64);
    const identityOutput = `  1) ${fingerprint} "Apple Development: Test (${teamId})"
     1 valid identities found`;
    const { deps, writtenFiles } = createFakeDependencies({ identities: identityOutput });
    const manager = new XcodeSigningManager(deps);

    const resolution = await manager.resolveSigningForDevice(deviceUdid);

    expect(resolution.style).toBe("manual");
    expect(resolution.profile?.uuid).toBe(profileUuid);
    expect(resolution.identity?.fingerprint).toBe(fingerprint);
    expect(resolution.buildSettings.join(" ")).toContain("CODE_SIGN_STYLE=Manual");
    expect(resolution.buildSettings.join(" ")).toContain(
      `PROVISIONING_PROFILE_SPECIFIER=\"${profileName}\"`,
    );
    expect(writtenFiles.length).toBe(1);
  });

  test("falls back to automatic signing when identity is missing", async () => {
    const { deps } = createFakeDependencies({ identities: "" });
    const manager = new XcodeSigningManager(deps);

    const resolution = await manager.resolveSigningForDevice(deviceUdid);

    expect(resolution.style).toBe("automatic");
    expect(resolution.allowProvisioningUpdates).toBe(true);
  });

  test("detects team IDs from Xcode project under daemon launch cwd", async () => {
    const launchCwd = resolve("/Users/test/project");
    process.env[DAEMON_LAUNCH_CWD_ENV] = launchCwd;
    const { deps, xcodebuildArgs } = createFakeDependencies();
    const manager = new XcodeSigningManager(deps);

    await expect(manager.detectTeamIdsFromXcode()).resolves.toEqual([teamId]);

    // REWRITE-4 (#4177 item 14): assert the WHOLE argv, not just the
    // -project/value pair. A `-project value` proximity check still passes if an
    // extra argument is inserted between the flag and its value, or if the
    // scheme/showBuildSettings flags drift; the full-array form catches all three.
    expect(xcodebuildArgs[0]).toEqual([
      "-showBuildSettings",
      "-project",
      join(launchCwd, "ios", "control-proxy", "CtrlProxy.xcodeproj"),
      "-scheme",
      "CtrlProxyApp",
    ]);
  });
});
