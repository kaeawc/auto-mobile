import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { record } from "./prototypeTemplate";
import type { PrototypePlatformNote } from "./prototypePlatformNotes";

const nativeClickables = new Set([
  "button",
  "iconButton",
  "fab",
  "chip",
  "switch",
  "checkbox",
  "radioGroup",
  "select",
  "segmentedButton",
  "tabBar",
  "bottomNav",
  "datePicker",
  "timePicker",
  "pasteButton",
]);

function androidIgnored(node: Record<string, unknown>, key: string): boolean {
  if (key === "predictiveBack") {
    return node.type !== "stack";
  }
  return (
    key === "indication" &&
    !nativeClickables.has(String(node.type)) &&
    !node.onTap &&
    !node.onLongPress &&
    !node.onDoubleTap
  );
}

function namespaceFieldEffect(
  node: Record<string, unknown>,
  key: string,
  platform: "ios" | "android",
  osMajor?: number,
): "ignored" | "substituted" | undefined {
  if (platform === "android") {
    return androidIgnored(node, key) ? "ignored" : undefined;
  }
  if (key === "hover") {
    return undefined;
  }
  if (key === "buttonStyle" && node.type === "button") {
    return osMajor === undefined || osMajor < 26 ? "substituted" : undefined;
  }
  return "ignored";
}

/** Namespace fields that cannot affect the current renderer's custom chrome. */
export function prototypeNamespaceNotes(
  spec: unknown,
  platform: "ios" | "android",
  osMajor?: number,
): PrototypePlatformNote[] {
  const affected = { ignored: [] as string[], substituted: [] as string[] };
  walkPrototypeNodes(spec, (node, path) => {
    for (const key of Object.keys(record(node[platform]) ?? {})) {
      const effect = namespaceFieldEffect(node, key, platform, osMajor);
      if (effect) {
        const suffix = key === "tab" ? ".role" : key === "sheet" ? ".sizing" : "";
        affected[effect].push(`${path}.${platform}.${key}${suffix}`);
      }
    }
  });
  const object = record(spec);
  for (const key of ["window", "theme"]) {
    if (record(record(object?.[key])?.[platform])) {
      affected.ignored.push(`${key}.${platform}`);
    }
  }
  const details = {
    ignored:
      "These namespace fields have no applicable native chrome or interaction in this renderer; custom tab bars, app bars and sheets retain observable identities.",
    substituted:
      "Glass buttons use the bordered style below iOS 26; when the OS version is unknown this fallback may apply.",
  };
  return (["ignored", "substituted"] as const).flatMap((effect): PrototypePlatformNote[] => {
    const paths = affected[effect];
    return paths.length
      ? [
          {
            platform,
            construct: "platformNamespace",
            effect,
            paths: paths.slice(0, 20),
            ...(paths.length > 20 ? { total: paths.length } : {}),
            detail: details[effect],
          },
        ]
      : [];
  });
}
