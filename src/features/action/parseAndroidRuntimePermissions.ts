import type { AppPermissionStateResult } from "./AppPermissions";

export interface AndroidPackagePermissionState {
  requestedPermissions: Set<string>;
  installPermissions: Map<string, AppPermissionStateResult>;
  runtimePermissions: Map<string, AppPermissionStateResult>;
}

interface DumpSection {
  text: string;
  indent: number;
  children: DumpSection[];
}

/** Keep parent/child relationships, including empty section headers. */
function packageDumpSections(output: string): DumpSection[] {
  const sections: DumpSection[] = [];
  const parents: DumpSection[] = [];
  for (const rawLine of output.split("\n")) {
    const text = rawLine.trim();
    if (!text) {
      continue;
    }
    const indent = rawLine.length - rawLine.trimStart().length;
    while (parents.length && parents[parents.length - 1].indent >= indent) {
      parents.pop();
    }
    const section: DumpSection = { text, indent, children: [] };
    parents[parents.length - 1]?.children.push(section);
    sections.push(section);
    parents.push(section);
  }
  return sections;
}

function permissionStates(section: DumpSection | undefined): Map<string, AppPermissionStateResult> {
  const permissions = new Map<string, AppPermissionStateResult>();
  for (const { text } of section?.children ?? []) {
    const match = text.match(/^([A-Za-z0-9_.]+):\s+granted=(true|false)\b(.*)$/);
    if (!match) {
      continue;
    }
    const [, permission, granted, rest] = match;
    permissions.set(permission, {
      permission,
      state: granted === "true" ? "granted" : "denied",
      source: "androidRuntime",
      raw: { granted: granted === "true", flags: rest.trim() || null },
    });
  }
  return permissions;
}

function sharedUserSection(pkg: DumpSection, sections: DumpSection[]): DumpSection | undefined {
  const sharedUserSetting = pkg.children.find((section) =>
    section.text.startsWith("sharedUser=SharedUserSetting{"),
  );
  const sharedUserName = sharedUserSetting?.text.split(" ")[1]?.split("/")[0];
  return sharedUserName
    ? sections
        .find((section) => section.text === "Shared users:")
        ?.children.find((section) => section.text.startsWith(`SharedUser [${sharedUserName}]`))
    : undefined;
}

/** Parse the named package's permissions, including its shared UID, for only the target user. */
export function parseAndroidRuntimePermissions(
  output: string,
  packageName: string,
  userId: number = 0,
): AndroidPackagePermissionState | undefined {
  const sections = packageDumpSections(output);
  const pkg = sections.find((section) => section.text.startsWith(`Package [${packageName}]`));
  const requested = pkg?.children.find((section) => section.text === "requested permissions:");
  if (!pkg) {
    return undefined;
  }
  const sharedUser = sharedUserSection(pkg, sections);
  const install =
    pkg.children.find((section) => section.text === "install permissions:") ??
    sharedUser?.children.find((section) => section.text === "install permissions:");
  const user = pkg.children.find((section) => section.text.startsWith(`User ${userId}:`));
  const sharedUserUser = sharedUser?.children.find((section) =>
    section.text.startsWith(`User ${userId}:`),
  );
  const runtime =
    user?.children.find((section) => section.text === "runtime permissions:") ??
    sharedUserUser?.children.find((section) => section.text === "runtime permissions:");
  return {
    requestedPermissions: new Set(requested?.children.map((section) => section.text) ?? []),
    installPermissions: permissionStates(install),
    runtimePermissions: permissionStates(runtime),
  };
}
