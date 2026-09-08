import { defaultIdGenerator, type IdGenerator } from "../../utils/IdGenerator";
import { parseStringPromise } from "xml2js";
import type { ViewHierarchyNode, ViewHierarchyResult, HierarchySource } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { Timer } from "../../utils/SystemTimer";
import { parseBounds } from "../../utils/bounds";
import { throwIfAborted } from "../../utils/toolUtils";
import { logger } from "../../utils/logger";
import { DefaultElementParser } from "../utility/ElementParser";

export interface AndroidHierarchyFallbackDeps {
  adb: Pick<AdbExecutor, "execute" | "getForegroundApp">;
  timer: Timer;
  idGenerator?: IdGenerator;
}

interface XmlNode {
  $?: Record<string, string>;
  node?: XmlNode[];
}

// Resource IDs repeat in lists and across windows. Only identical visible
// descriptors at identical coordinates can be discarded in favor of CtrlProxy.
function nodeKey(attributes: Record<string, unknown>, bounds: unknown): string {
  const rect = parseBounds(bounds ?? attributes.bounds);
  return JSON.stringify([
    attributes.package,
    attributes.class,
    attributes["resource-id"] ?? "",
    attributes.text ?? "",
    attributes["content-desc"] ?? "",
    rect ? [rect.left, rect.top, rect.right, rect.bottom] : null,
  ]);
}

function missingXmlNodes(
  nodes: XmlNode[],
  nativeKeys: Set<string>,
  packageName: string,
): ViewHierarchyNode[] {
  return nodes.flatMap((node) => {
    const children = missingXmlNodes(node.node ?? [], nativeKeys, packageName);
    const attributes = node.$;
    const bounds = parseBounds(attributes?.bounds);
    if (
      !attributes ||
      attributes.package !== packageName ||
      !bounds ||
      bounds.right <= bounds.left ||
      bounds.bottom <= bounds.top
    ) {
      return children;
    }
    const candidate: ViewHierarchyNode = {
      $: { ...attributes, "hierarchy-source": "uiautomator" },
      bounds,
      ...(children.length ? { node: children } : {}),
    };
    // The XML format has no native action identity. Never manufacture or accept
    // one from a dump: these nodes are coordinate-only candidates.
    delete candidate.$["view-id"];
    delete candidate.$["unique-id"];
    delete candidate.$.actions;
    if (nativeKeys.has(nodeKey(candidate.$, candidate.bounds))) {
      return children;
    }
    return [candidate];
  });
}

function mergeMissingNodes(
  original: ViewHierarchyResult,
  nodes: XmlNode[],
  packageName: string,
): ViewHierarchyResult {
  const parser = new DefaultElementParser();
  const nativeKeys = new Set(
    parser
      .flattenViewHierarchy(original, { includeWindows: true })
      .map((entry) => nodeKey(entry.element, entry.element.bounds)),
  );
  const missing = missingXmlNodes(nodes, nativeKeys, packageName);
  if (!missing.length) {
    return original;
  }
  // Keep native roots/IDs untouched. The XML additions cannot inherit a
  // device-authored frame token, receipt timestamp, or verified freshness.
  const merged: ViewHierarchyResult = {
    ...original,
    packageName: packageName,
    hierarchy: { node: { $: {}, node: [...parser.extractRootNodes(original), ...missing] } },
    sources: [
      ...new Set<HierarchySource>([...(original.sources ?? ["control-proxy"]), "uiautomator"]),
    ],
    fresh: false,
  };
  delete merged.frameContext;
  delete merged.receivedAt;
  delete merged.updatedAt;
  return merged;
}

/** Add missing same-app XML content without certifying a mixed capture as complete. */
export async function supplementAndroidHierarchy(
  original: ViewHierarchyResult,
  deps: AndroidHierarchyFallbackDeps,
  deadline: number,
  signal?: AbortSignal,
): Promise<ViewHierarchyResult> {
  throwIfAborted(signal);
  if (deps.timer.now() >= deadline) {
    return original;
  }
  const path = dumpPath(deps.idGenerator);
  const execute = async (args: string[]) => {
    throwIfAborted(signal);
    const remaining = deadline - deps.timer.now();
    if (remaining <= 0) {
      throw new Error("Hierarchy fallback deadline exhausted");
    }
    return deps.adb.execute(args, {
      timeoutMs: remaining,
      signal,
      noRetry: true,
      maxBuffer: 4 * 1024 * 1024,
    });
  };
  try {
    const foreground = await deps.adb.getForegroundApp(signal, deadline - deps.timer.now());
    if (!foreground) {
      return original;
    }
    if (original.packageName !== undefined && original.packageName !== foreground.packageName) {
      return original;
    }
    await execute(["shell", "uiautomator", "dump", path]);
    const result = await execute(["shell", "cat", path]);
    throwIfAborted(signal);
    return await verifyAndMergeDump(original, result.stdout, foreground, deps, deadline, signal);
  } catch (error) {
    throwIfAborted(signal);
    logger.debug("[HierarchyFallback] Could not supplement incomplete CtrlProxy hierarchy", error);
    return original;
  } finally {
    await removeDump(deps, path, deadline);
  }
}

async function removeDump(
  deps: AndroidHierarchyFallbackDeps,
  path: string,
  deadline: number,
): Promise<void> {
  const remaining = deadline - deps.timer.now();
  if (remaining > 0) {
    try {
      await deps.adb.execute(["shell", "rm", "-f", path], {
        timeoutMs: Math.min(remaining, 100),
        noRetry: true,
      });
    } catch (error) {
      logger.debug("[HierarchyFallback] Could not remove temporary dump", error);
    }
  }
}

function dumpPath(idGenerator: IdGenerator = defaultIdGenerator): string {
  return `/data/local/tmp/automobile-hierarchy-${idGenerator.next()}.xml`;
}

async function verifyAndMergeDump(
  original: ViewHierarchyResult,
  contents: string,
  foreground: { packageName: string; userId: number },
  deps: AndroidHierarchyFallbackDeps,
  deadline: number,
  signal?: AbortSignal,
): Promise<ViewHierarchyResult> {
  const parsed: { hierarchy?: XmlNode } = await parseStringPromise(contents, {
    explicitArray: true,
  });
  const nodes = parsed.hierarchy?.node;
  if (!Array.isArray(nodes) || deps.timer.now() >= deadline) {
    return original;
  }
  const currentApp = await deps.adb.getForegroundApp(signal, deadline - deps.timer.now());
  throwIfAborted(signal);
  if (
    currentApp?.packageName !== foreground.packageName ||
    currentApp?.userId !== foreground.userId ||
    deps.timer.now() >= deadline
  ) {
    return original;
  }
  return mergeMissingNodes(original, nodes, foreground.packageName);
}
