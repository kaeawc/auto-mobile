/**
 * iOS half of the ProtoViewer release-artifact policy gate (issue #14154).
 *
 * Facts come from the built `.app` (or the `.app` inside an exported `.ipa`): `plutil` converts
 * Info.plist and the codesign entitlements to JSON, `nm` lists the executable's symbols and debug
 * map. Nothing here reads source plists, so an Info.plist rewritten by the build is what is judged.
 */

import type { IosPolicy, PolicyFinding } from "./policyData";
import type { ToolRunner } from "./toolRunner";

export type IosPlatform = "iPhoneOS" | "iPhoneSimulator";

export interface IosBundleFiles {
  /** Paths relative to the `.app`, using `/` separators; directories included. */
  list(): readonly string[];
}

export interface IosArtifact {
  readonly infoPlist: Readonly<Record<string, unknown>>;
  readonly entitlements: Readonly<Record<string, unknown>>;
  readonly symbols: readonly string[];
  /** Debug-map (stab) entries in the executable's symbol table; zero once debug info is stripped. */
  readonly debugStabs: number;
  readonly bundlePaths: readonly string[];
}

export interface IosPolicyOptions {
  readonly platform: IosPlatform;
}

const NM_ROW = /^(?:[0-9a-fA-F]{8,16}| {16}) (\S) (.+)$/;

/** Split `nm -a` output into symbol names and a count of debug-map (stab) rows. */
export function parseNmOutput(output: string): { symbols: string[]; debugStabs: number } {
  const symbols: string[] = [];
  let debugStabs = 0;
  for (const line of output.split("\n")) {
    const row = NM_ROW.exec(line);
    if (!row) {
      continue;
    }
    if (row[1] === "-") {
      debugStabs += 1;
    } else {
      symbols.push(row[2]);
    }
  }
  return { symbols, debugStabs };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonDictionary(json: string, label: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value)) {
    throw new Error(`${label} is not a dictionary`);
  }
  return value;
}

/** Keys at any depth that relax App Transport Security. */
function atsKeys(value: unknown, path: string): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => atsKeys(entry, `${path}[${index}]`));
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) => {
    const here = path === "" ? key : `${path}.${key}`;
    const relaxes = key === "NSAppTransportSecurity" || key.startsWith("NSAllows");
    return [...(relaxes ? [here] : []), ...atsKeys(child, here)];
  });
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function entitlementFindings(artifact: IosArtifact, policy: IosPolicy): PolicyFinding[] {
  const keys = Object.keys(artifact.entitlements);
  // A distribution profile may state `get-task-allow` as an explicit false; only a value that is
  // not false (true, or anything unreadable) re-enables debugger attach.
  const forbidden = keys.filter(
    (key) => policy.forbiddenEntitlements.includes(key) && artifact.entitlements[key] !== false,
  );
  const unexpected = keys.filter(
    (key) =>
      !policy.allowedEntitlements.includes(key) &&
      !forbidden.includes(key) &&
      !policy.forbiddenEntitlements.includes(key),
  );
  return [
    ...(forbidden.length > 0
      ? [
          {
            rule: "ios.entitlements",
            message: `forbidden entitlements present: ${sorted(forbidden).join(", ")}`,
          },
        ]
      : []),
    ...(unexpected.length > 0
      ? [
          {
            rule: "ios.entitlements",
            message: `entitlements outside the allowlist: ${sorted(unexpected).join(", ")}`,
          },
        ]
      : []),
  ];
}

function hasDsym(paths: readonly string[]): boolean {
  return paths.some((entry) => entry.split("/").some((part) => part.endsWith(".dSYM")));
}

/** Every policy violation in one iOS artifact; empty when it conforms. */
export function evaluateIosPolicy(
  artifact: IosArtifact,
  policy: IosPolicy,
  options: IosPolicyOptions,
): PolicyFinding[] {
  const { infoPlist } = artifact;
  const findings: PolicyFinding[] = [];
  if (infoPlist.CFBundleIdentifier !== policy.bundleIdentifier) {
    findings.push({
      rule: "ios.bundleIdentifier",
      message: `CFBundleIdentifier is ${String(infoPlist.CFBundleIdentifier ?? "missing")}, expected ${policy.bundleIdentifier}`,
    });
  }
  const platforms = infoPlist.CFBundleSupportedPlatforms;
  if (!Array.isArray(platforms) || platforms.length !== 1 || platforms[0] !== options.platform) {
    findings.push({
      rule: "ios.platform",
      message: `CFBundleSupportedPlatforms must be exactly [${options.platform}], found ${JSON.stringify(platforms ?? null)}`,
    });
  }
  const ats = atsKeys(infoPlist, "");
  if (ats.length > 0) {
    findings.push({
      rule: "ios.ats",
      message: `App Transport Security is relaxed by ${ats.join(", ")}`,
    });
  }
  for (const key of policy.forbiddenInfoPlistKeys.filter((entry) => entry in infoPlist)) {
    findings.push({ rule: "ios.infoPlist", message: `Info.plist must not set ${key}` });
  }
  findings.push(...entitlementFindings(artifact, policy));
  const leaked = policy.forbiddenSymbols.filter((symbol) =>
    artifact.symbols.some((name) => name.includes(symbol)),
  );
  if (leaked.length > 0) {
    findings.push({
      rule: "ios.forbiddenSymbols",
      message: `executable contains forbidden symbols: ${leaked.join(", ")}`,
    });
  }
  if (artifact.debugStabs > 0) {
    findings.push({
      rule: "ios.debugInfo",
      message: `executable still carries ${artifact.debugStabs} debug-map symbol rows; strip it`,
    });
  }
  if (hasDsym(artifact.bundlePaths)) {
    findings.push({ rule: "ios.debugInfo", message: "a .dSYM ships inside the app bundle" });
  }
  if (!artifact.bundlePaths.includes(policy.privacyManifest)) {
    findings.push({
      rule: "ios.privacyManifest",
      message: `${policy.privacyManifest} is missing from the app bundle`,
    });
  }
  return findings;
}

/** Read Info.plist, entitlements and symbols from a built `.app` with plutil, codesign and nm. */
export async function collectIosArtifact(
  appPath: string,
  runner: ToolRunner,
  files: IosBundleFiles,
): Promise<IosArtifact> {
  const infoPlist = parseJsonDictionary(
    (await runner.run("plutil", ["-convert", "json", "-o", "-", `${appPath}/Info.plist`])).stdout,
    "Info.plist",
  );
  const executable = infoPlist.CFBundleExecutable;
  if (typeof executable !== "string" || executable === "") {
    throw new Error("Info.plist has no CFBundleExecutable");
  }
  const entitlementsXml = (await runner.run("codesign", ["-d", "--entitlements", ":-", appPath]))
    .stdout;
  const entitlements =
    entitlementsXml.trim() === ""
      ? {}
      : parseJsonDictionary(
          (await runner.run("plutil", ["-convert", "json", "-o", "-", "-"], entitlementsXml))
            .stdout,
          "entitlements",
        );
  const { symbols, debugStabs } = parseNmOutput(
    (await runner.run("nm", ["-a", `${appPath}/${executable}`])).stdout,
  );
  return { infoPlist, entitlements, symbols, debugStabs, bundlePaths: files.list() };
}
