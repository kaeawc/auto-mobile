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

/** Parse only the named package and target user's indented permission sections. */
export function parseAndroidRuntimePermissions(
  output: string,
  packageName: string,
  userId: number = 0,
): AndroidPackagePermissionState | undefined {
  const pkg = packageDumpSections(output).find((section) =>
    section.text.startsWith(`Package [${packageName}]`),
  );
  const requested = pkg?.children.find((section) => section.text === "requested permissions:");
  if (!requested) {
    return undefined;
  }
  const install = pkg?.children.find((section) => section.text === "install permissions:");
  const user = pkg?.children.find((section) => section.text.startsWith(`User ${userId}:`));
  const runtime = user?.children.find((section) => section.text === "runtime permissions:");
  return {
    requestedPermissions: new Set(requested.children.map((section) => section.text)),
    installPermissions: permissionStates(install),
    runtimePermissions: permissionStates(runtime),
  };
}
