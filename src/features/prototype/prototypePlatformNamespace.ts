import { PROTOTYPE_PLATFORM_NAMESPACE_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { record } from "./prototypeTemplate";

export { PROTOTYPE_PLATFORM_NAMESPACE_CAPABILITY };

/** Authored namespace object paths; opaque data and repeat items are never nodes. */
export function prototypePlatformNamespaceFields(
  spec: unknown,
  platform: "ios" | "android",
): string[] {
  const paths: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if (record(node[platform])) {
      paths.push(`${path}.${platform}`);
    }
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
