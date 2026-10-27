/**
 * Android half of the ProtoViewer release-artifact policy gate (issue #14154).
 *
 * Facts come from the compiled manifest inside the built APK (`aapt2 dump xmltree`), which is the
 * merged result of the app, its libraries and the build type, so a library manifest merge or a
 * convention plugin that carries CtrlProxy's posture over (allowBackup, cleartext, privileged
 * permissions) is caught here even though the source manifest looks clean.
 */

import {
  booleanAttribute,
  childrenNamed,
  findAll,
  parseAaptXmlTree,
  parseXmlResourceFiles,
  type XmlTreeNode,
} from "./aaptXmlTree";
import type { AndroidPolicy, PolicyFinding } from "./policyData";
import type { ToolRunner } from "./toolRunner";

const COMPONENT_KINDS = ["activity", "activity-alias", "service", "receiver", "provider"] as const;
type ComponentKind = (typeof COMPONENT_KINDS)[number];

export interface AndroidComponentFacts {
  readonly kind: ComponentKind;
  readonly name: string;
  readonly exported: boolean;
  readonly permission?: string;
}

export interface AndroidManifestFacts {
  readonly packageName: string;
  readonly versionName: string | undefined;
  readonly targetSdk: number | undefined;
  readonly debuggable: boolean;
  readonly allowBackup: boolean | undefined;
  readonly hasDataExtractionRules: boolean;
  readonly usesCleartextTraffic: boolean | undefined;
  /** Resource id (`0x7f...`) of the network security config, when the app declares one. */
  readonly networkSecurityConfigResource: string | undefined;
  readonly permissions: readonly string[];
  readonly declaredPermissions: readonly string[];
  readonly components: readonly AndroidComponentFacts[];
}

export interface AndroidArtifact {
  readonly manifest: AndroidManifestFacts;
  /** Parsed network security config files; `null` when the declared resource did not resolve. */
  readonly networkConfigs: readonly XmlTreeNode[] | null;
}

export interface AndroidPolicyOptions {
  /** Local and pull-request builds carry the development `-SNAPSHOT` versionName. */
  readonly allowSnapshotVersion: boolean;
}

function componentFacts(
  kind: ComponentKind,
  node: XmlTreeNode,
  applicationPermission: string | undefined,
): AndroidComponentFacts {
  const explicit = booleanAttribute(node, "exported");
  // An absent `exported` means exported exactly when the component declares an intent filter
  // (providers default to not exported); modern merged manifests always state it.
  const implicit = kind !== "provider" && childrenNamed(node, "intent-filter").length > 0;
  // A component without its own permission inherits the application's.
  const permission = node.attributes.permission ?? applicationPermission;
  return {
    kind,
    name: node.attributes.name ?? "",
    exported: explicit ?? implicit,
    ...(permission === undefined ? {} : { permission }),
  };
}

/** Reduce the manifest tree of an APK to the facts the policy checks. */
export function extractManifestFacts(manifest: XmlTreeNode): AndroidManifestFacts {
  const application = childrenNamed(manifest, "application")[0];
  const usesSdk = childrenNamed(manifest, "uses-sdk")[0];
  const networkConfig = application?.attributes.networkSecurityConfig;
  const targetSdk = usesSdk?.attributes.targetSdkVersion;
  return {
    packageName: manifest.attributes.package ?? "",
    versionName: manifest.attributes.versionName,
    targetSdk: targetSdk === undefined ? undefined : Number.parseInt(targetSdk, 10),
    debuggable:
      application === undefined ? false : booleanAttribute(application, "debuggable") === true,
    allowBackup:
      application === undefined ? undefined : booleanAttribute(application, "allowBackup"),
    hasDataExtractionRules: application?.attributes.dataExtractionRules !== undefined,
    usesCleartextTraffic:
      application === undefined ? undefined : booleanAttribute(application, "usesCleartextTraffic"),
    networkSecurityConfigResource: networkConfig?.startsWith("@")
      ? networkConfig.slice(1).toLowerCase()
      : undefined,
    permissions: manifest.children
      .filter((child) => child.name.startsWith("uses-permission"))
      .map((child) => child.attributes.name ?? ""),
    declaredPermissions: childrenNamed(manifest, "permission").map(
      (child) => child.attributes.name ?? "",
    ),
    components: COMPONENT_KINDS.flatMap((kind) =>
      childrenNamed(application ?? manifest, kind).map((node) =>
        componentFacts(kind, node, application?.attributes.permission),
      ),
    ),
  };
}

function sorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function setDifference(actual: readonly string[], expected: readonly string[]) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return {
    extra: sorted(actual.filter((value) => !expectedSet.has(value))),
    missing: sorted(expected.filter((value) => !actualSet.has(value))),
  };
}

function equalityFinding(
  rule: string,
  label: string,
  actual: readonly string[],
  expected: readonly string[],
): PolicyFinding[] {
  const { extra, missing } = setDifference(actual, expected);
  const parts = [
    ...(extra.length > 0 ? [`unexpected: ${extra.join(", ")}`] : []),
    ...(missing.length > 0 ? [`missing: ${missing.join(", ")}`] : []),
  ];
  return parts.length === 0
    ? []
    : [{ rule, message: `${label} differ from the allowlist; ${parts.join("; ")}` }];
}

function componentKey(component: { kind: string; name: string }): string {
  return `${component.kind} ${component.name}`;
}

function exportedComponentFindings(
  facts: AndroidManifestFacts,
  policy: AndroidPolicy,
): PolicyFinding[] {
  const exported = facts.components.filter((component) => component.exported);
  const findings = equalityFinding(
    "android.exportedComponents",
    "exported components",
    exported.map(componentKey),
    policy.exportedComponents.map(componentKey),
  );
  const expectedPermission = new Map(
    policy.exportedComponents.map((component) => [componentKey(component), component.permission]),
  );
  const permissionFindings = exported.flatMap((component): PolicyFinding[] => {
    const required = expectedPermission.get(componentKey(component));
    return required !== undefined && component.permission !== required
      ? [
          {
            rule: "android.exportedComponents",
            message: `${componentKey(component)} must be protected by ${required}, found ${component.permission ?? "no permission"}`,
          },
        ]
      : [];
  });
  return [...findings, ...permissionFindings];
}

function cleartextFindings(
  facts: AndroidManifestFacts,
  networkConfigs: readonly XmlTreeNode[] | null,
): PolicyFinding[] {
  const findings: PolicyFinding[] = [];
  if (facts.usesCleartextTraffic === true) {
    findings.push({
      rule: "android.cleartext",
      message: "application sets usesCleartextTraffic=true",
    });
  }
  if (facts.networkSecurityConfigResource !== undefined && networkConfigs === null) {
    findings.push({
      rule: "android.cleartext",
      message: `network security config ${facts.networkSecurityConfigResource} did not resolve to a file in the APK, so cleartext could not be ruled out`,
    });
  }
  for (const config of networkConfigs ?? []) {
    const cleartext = [
      ...findAll(config, "base-config"),
      ...findAll(config, "domain-config"),
    ].filter((node) => node.attributes.cleartextTrafficPermitted === "true");
    for (const node of cleartext) {
      findings.push({
        rule: "android.cleartext",
        message: `network security config permits cleartext traffic in <${node.name}>`,
      });
    }
  }
  return findings;
}

/** Every policy violation in one Android artifact; empty when it conforms. */
export function evaluateAndroidPolicy(
  artifact: AndroidArtifact,
  policy: AndroidPolicy,
  options: AndroidPolicyOptions,
): PolicyFinding[] {
  const { manifest } = artifact;
  const findings: PolicyFinding[] = [];
  if (manifest.packageName !== policy.applicationId) {
    findings.push({
      rule: "android.applicationId",
      message: `applicationId is ${manifest.packageName || "missing"}, expected ${policy.applicationId}`,
    });
  }
  if (manifest.debuggable) {
    findings.push({ rule: "android.debuggable", message: "application is debuggable" });
  }
  if (manifest.allowBackup !== false) {
    findings.push({
      rule: "android.allowBackup",
      message: `allowBackup must be false, found ${manifest.allowBackup === undefined ? "unset (defaults to true)" : "true"}`,
    });
  }
  if (!manifest.hasDataExtractionRules) {
    findings.push({
      rule: "android.dataExtractionRules",
      message: "dataExtractionRules is not declared",
    });
  }
  findings.push(...cleartextFindings(manifest, artifact.networkConfigs));
  findings.push(
    ...equalityFinding(
      "android.permissions",
      "uses-permission entries",
      manifest.permissions,
      policy.permissions,
    ),
    ...equalityFinding(
      "android.declaredPermissions",
      "declared permissions",
      manifest.declaredPermissions,
      policy.declaredPermissions,
    ),
    ...exportedComponentFindings(manifest, policy),
  );
  if (manifest.targetSdk === undefined || manifest.targetSdk < policy.minTargetSdk) {
    findings.push({
      rule: "android.targetSdk",
      message: `targetSdk ${manifest.targetSdk ?? "missing"} is below the Play floor ${policy.minTargetSdk}`,
    });
  }
  if (!options.allowSnapshotVersion && /-SNAPSHOT$/i.test(manifest.versionName ?? "")) {
    findings.push({
      rule: "android.versionName",
      message: `release versionName ${manifest.versionName} is a -SNAPSHOT`,
    });
  }
  return findings;
}

/** Read the manifest and any network security config out of a built APK with aapt2. */
export async function collectAndroidArtifact(
  apkPath: string,
  aapt2: string,
  runner: ToolRunner,
): Promise<AndroidArtifact> {
  const dumpTree = async (file: string): Promise<XmlTreeNode> =>
    parseAaptXmlTree(
      (await runner.run(aapt2, ["dump", "xmltree", "--file", file, apkPath])).stdout,
    );
  const manifest = extractManifestFacts(await dumpTree("AndroidManifest.xml"));
  if (manifest.networkSecurityConfigResource === undefined) {
    return { manifest, networkConfigs: [] };
  }
  const resources = parseXmlResourceFiles(
    (await runner.run(aapt2, ["dump", "resources", apkPath])).stdout,
  );
  const files = resources.get(manifest.networkSecurityConfigResource) ?? [];
  return {
    manifest,
    networkConfigs: files.length === 0 ? null : await Promise.all(files.map(dumpTree)),
  };
}
