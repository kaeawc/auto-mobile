import { PROTOTYPE_PLATFORM_NAMESPACE_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { prototypeGlassNamespaceFields } from "./prototypeGlass";
import { record } from "./prototypeTemplate";

export { PROTOTYPE_PLATFORM_NAMESPACE_CAPABILITY };

/** Authored namespace object paths; opaque data and repeat items are never nodes. */
export function prototypePlatformNamespaceFields(
  spec: unknown,
  platform: "ios" | "android",
): string[] {
  const paths: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    const namespace = record(node[platform]);
    if (!namespace) {
      return;
    }
    const keys = Object.keys(namespace);
    if (
      platform === "ios" &&
      keys.length > 0 &&
      keys.every((key) => prototypeGlassNamespaceFields.includes(key))
    ) {
      return;
    }
    paths.push(`${path}.${platform}`);
  });
  const object = record(spec);
  for (const key of ["window", "theme"]) {
    if (record(record(object?.[key])?.[platform])) {
      paths.push(`${key}.${platform}`);
    }
  }
  return paths;
}

export function prototypePlatformNamespaceUnsupportedMessage(
  fields: readonly string[],
  platform: "ios" | "android",
): string {
  return `The connected ${platform} renderer does not advertise ${PROTOTYPE_PLATFORM_NAMESPACE_CAPABILITY}, required for ${fields[0]}. Nothing was shown or patched. Update the renderer or omit the ${platform} namespace blocks.`;
}

/** Ignored glass fields retain their individual paths in diagnostics on the foreign platform. */
export function prototypeIgnoredNamespaceFields(
  spec: unknown,
  platform: "ios" | "android",
): string[] {
  if (platform === "android") {
    return prototypePlatformNamespaceFields(spec, platform);
  }
  const paths: string[] = [];
  const glassKeys = prototypeGlassNamespaceFields;
  walkPrototypeNodes(spec, (node, path) => {
    const ios = record(node.ios);
    if (!ios) {
      return;
    }
    if (Object.keys(ios).some((key) => !glassKeys.includes(key)) || Object.keys(ios).length === 0) {
      paths.push(`${path}.ios`);
    }
    for (const key of glassKeys) {
      if (ios[key] !== undefined) {
        paths.push(`${path}.ios.${key}`);
      }
    }
  });
  for (const key of ["window", "theme"]) {
    if (record(record(record(spec)?.[key])?.ios)) {
      paths.push(`${key}.ios`);
    }
  }
  return paths;
}
