import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { record } from "./prototypeTemplate";

const glassNamespaceFields = ["glassGroup", "glassUnion", "glassTransition", "backgroundExtension"];
const glassContainers = ["column", "row", "box", "flow", "grid", "list", "listItem"];

/** Visit authored styles, including conditional styles and unexpanded component templates. */
export function prototypeGlassFields(spec: unknown, platform?: "ios" | "android"): string[] {
  const paths: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    const styles = [
      { value: node.style, path: `${path}.style` },
      ...(Array.isArray(node.styleWhen) ? node.styleWhen : []).map((entry, index) => ({
        value: record(entry)?.style,
        path: `${path}.styleWhen[${index}].style`,
      })),
    ];
    for (const slot of styles) {
      const style = record(slot.value);
      for (const key of ["surface", "glass"]) {
        if (style?.[key] !== undefined) {
          paths.push(`${slot.path}.${key}`);
        }
      }
    }
    if (platform !== "android") {
      for (const key of glassNamespaceFields) {
        if (record(node.ios)?.[key] !== undefined) {
          paths.push(`${path}.ios.${key}`);
        }
      }
    }
  });
  return paths;
}

export function prototypeScrollEdgeEffectFields(spec: unknown): string[] {
  const paths: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if (node.type === "scroll" && node.edgeEffect !== undefined) {
      paths.push(`${path}.edgeEffect`);
    }
  });
  return paths;
}

/** Shared semantic rules run after structural validation, in the same order on all platforms. */
export function prototypeGlassObjectError(
  data: Record<string, unknown>,
  kind: string,
  path: string,
): { path: string; message: string } | undefined {
  if (kind === "style" && data.glass !== undefined && data.surface !== "glass") {
    return { path: `${path}.glass`, message: 'glass requires surface: "glass"' };
  }
  return glassNamespaceError(data, path);
}
function glassNamespaceError(
  data: Record<string, unknown>,
  path: string,
): { path: string; message: string } | undefined {
  const ios = record(data.ios);
  if (!ios) {
    return undefined;
  }
  if (ios.glassGroup !== undefined && !glassContainers.includes(String(data.type))) {
    return { path: `${path}.ios.glassGroup`, message: "glassGroup requires a container node" };
  }
  for (const key of ["glassUnion", "glassTransition"]) {
    if (ios[key] !== undefined && record(data.style)?.surface !== "glass") {
      return { path: `${path}.ios.${key}`, message: `${key} requires a glass surface` };
    }
  }
  if (ios.backgroundExtension !== undefined && data.type !== "image") {
    return {
      path: `${path}.ios.backgroundExtension`,
      message: "backgroundExtension requires an image node",
    };
  }
  return undefined;
}

/** Glass IDs belong to the containing group, independently of two-node visibility pairs. */
export function isPrototypeGlassShared(
  node: Record<string, unknown>,
  path: string,
  nodes: { value: Record<string, unknown>; path: string }[],
): boolean {
  return (
    record(node.shared) !== undefined &&
    record(node.style)?.surface === "glass" &&
    nodes.some(
      (ancestor) =>
        path.startsWith(`${ancestor.path}.`) &&
        record(ancestor.value.ios)?.glassGroup !== undefined,
    )
  );
}
