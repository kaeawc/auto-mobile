import { ActionableError, toActionableError } from "../../models/ActionableError";
import { defaultIdGenerator, type IdGenerator } from "../../utils/IdGenerator";
import { parseStringPromise } from "xml2js";
import type { ViewHierarchyNode, ViewHierarchyResult, HierarchySource } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { Timer } from "../../utils/SystemTimer";
import { parseBounds } from "../../utils/bounds";
import { throwIfAborted } from "../../utils/toolUtils";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { logger } from "../../utils/logger";
import { rawNodeValue } from "../utility/elementProperties";
import { DefaultElementParser } from "../utility/ElementParser";
import {
  isAccessibilityUntrackedDisplay,
  parseAndroidDisplayInfos,
  parseDumpsysLogicalDisplays,
  type AndroidDisplayInfo,
} from "../../utils/android-cmdline-tools/AndroidDisplayParsers";
import { UntrackedAndroidDisplayError } from "../observe/UntrackedAndroidDisplayError";
import { uiautomatorDumpLock } from "./uiautomatorDumpLock";

const DUMP_CLEANUP_TIMEOUT_MS = 1500;

export interface AndroidHierarchyFallbackDeps {
  adb: Pick<AdbExecutor, "execute" | "getForegroundApp">;
  timer: Timer;
  idGenerator?: IdGenerator;
  /** Serializes dumps per device when known; see `uiautomatorDumpLock`. */
  deviceId?: string;
}

/** The absolute host-clock deadline and abort signal bounding one supplemental dump. */
interface DumpBound {
  deadline: number;
  signal?: AbortSignal;
}

/**
 * Run a dump-and-read under the device's UiAutomation lock when the device is known. The wait
 * for the lock is bounded by the capture's deadline and abort signal: a capture queued behind
 * another dump gives up when either ends instead of waiting for that dump to release. An
 * abandoned acquisition releases the lock as soon as it is granted, so later waiters proceed.
 */
async function withDumpLock<T>(
  deps: AndroidHierarchyFallbackDeps,
  { deadline, signal }: DumpBound,
  run: () => Promise<T>,
): Promise<T> {
  if (deps.deviceId === undefined) {
    return run();
  }
  throwIfAborted(signal);
  const remaining = deadline - deps.timer.now();
  if (remaining <= 0) {
    throw new Error("Hierarchy fallback deadline exhausted before the dump lock was free");
  }
  const acquisition = uiautomatorDumpLock(deps.deviceId).acquire();
  let release: () => void;
  try {
    release = await raceWithDeadline(acquisition, {
      timer: deps.timer,
      timeoutMs: remaining,
      signal,
      label: "Hierarchy fallback dump lock wait",
    });
  } catch (error) {
    void acquisition.then((granted) => granted());
    throw error;
  }
  try {
    return await run();
  } finally {
    release();
  }
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
    rawNodeValue(attributes, "resource-id") ?? "",
    rawNodeValue(attributes, "text") ?? "",
    rawNodeValue(attributes, "content-desc") ?? "",
    rect ? [rect.left, rect.top, rect.right, rect.bottom] : null,
  ]);
}

function missingXmlNodes(
  nodes: XmlNode[],
  nativeKeys: Set<string>,
  packageName?: string,
): ViewHierarchyNode[] {
  return nodes.flatMap((node) => {
    const children = missingXmlNodes(node.node ?? [], nativeKeys, packageName);
    const attributes = node.$;
    const bounds = parseBounds(attributes?.bounds);
    if (
      !attributes ||
      (packageName !== undefined && attributes.package !== packageName) ||
      !bounds ||
      bounds.right <= bounds.left ||
      bounds.bottom <= bounds.top
    ) {
      return children;
    }
    const candidateAttributes: Record<string, unknown> = {
      ...attributes,
      "hierarchy-source": "uiautomator",
    };
    const candidate: ViewHierarchyNode = {
      $: candidateAttributes,
      bounds,
      ...(children.length ? { node: children } : {}),
    };
    // The XML format has no native action identity. Never manufacture or accept
    // one from a dump: these nodes are coordinate-only candidates.
    delete candidateAttributes["view-id"];
    delete candidateAttributes["unique-id"];
    delete candidateAttributes.actions;
    if (nativeKeys.has(nodeKey(candidateAttributes, candidate.bounds))) {
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
  const execute = boundedDumpExecutor(deps, { deadline, signal });
  try {
    const foreground = await deps.adb.getForegroundApp(signal, deadline - deps.timer.now());
    if (!foreground) {
      return original;
    }
    if (original.packageName !== undefined && original.packageName !== foreground.packageName) {
      return original;
    }
    logger.warn(
      `[HierarchyFallback] Supplementing incomplete CtrlProxy hierarchy (ctrlProxyIncompleteReason=${original.ctrlProxyIncompleteReason ?? "unknown"})`,
    );
    const result = await withDumpLock(deps, { deadline, signal }, async () => {
      await execute(["shell", "uiautomator", "dump", path]);
      return execute(["shell", "cat", path]);
    });
    throwIfAborted(signal);
    return await verifyAndMergeDump(original, result.stdout, foreground, {
      deps,
      bound: {
        deadline,
        signal,
      },
    });
  } catch (error) {
    throwIfAborted(signal);
    logger.debug("[HierarchyFallback] Could not supplement incomplete CtrlProxy hierarchy", error);
    return original;
  } finally {
    await removeDump(deps, path, deadline, signal);
  }
}

async function removeDump(
  deps: AndroidHierarchyFallbackDeps,
  path: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<void> {
  const cleanup = deps.adb
    .execute(["shell", "rm", "-f", path], {
      timeoutMs: DUMP_CLEANUP_TIMEOUT_MS,
      // Override ADB's ambient request signal so cancellation still permits bounded cleanup.
      signal: new AbortController().signal,
      noRetry: true,
    })
    .catch((error: unknown) => {
      // Best-effort temporary-file removal must not replace the capture result or cancellation.
      logger.debug("[HierarchyFallback] Could not remove temporary dump", error);
    });
  const remaining = deadline - deps.timer.now();
  if (signal?.aborted || remaining <= 0) {
    void cleanup;
    throwIfAborted(signal);
    return;
  }
  try {
    await raceWithDeadline(cleanup, {
      timer: deps.timer,
      timeoutMs: remaining,
      signal,
      label: "Hierarchy fallback cleanup wait",
    });
  } catch (error) {
    // Cleanup has its own budget and rejection handler, so ending this wait safely detaches it.
    logger.debug("[HierarchyFallback] Stopped waiting for temporary dump cleanup", error);
  }
  throwIfAborted(signal);
}

function dumpPath(idGenerator: IdGenerator = defaultIdGenerator): string {
  return `/data/local/tmp/automobile-hierarchy-${idGenerator.next()}.xml`;
}

async function verifyAndMergeDump(
  original: ViewHierarchyResult,
  contents: string,
  foreground: { packageName: string; userId: number },
  { deps, bound }: { deps: AndroidHierarchyFallbackDeps; bound: DumpBound },
): Promise<ViewHierarchyResult> {
  const { deadline, signal } = bound;
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

function boundedDumpExecutor(
  deps: Pick<AndroidHierarchyFallbackDeps, "adb" | "timer">,
  { deadline, signal }: DumpBound,
) {
  return async (args: string[]) => {
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
}

/** The single non-empty package of a dump, or undefined for a mixed or package-less tree. */
function soleXmlPackage(nodes: readonly ViewHierarchyNode[]): string | undefined {
  const packages = new Set<string>();
  const visit = (node: ViewHierarchyNode): void => {
    const pkg = node.$?.package;
    if (typeof pkg === "string" && pkg) {
      packages.add(pkg);
    }
    (node.node ?? []).forEach(visit);
  };
  nodes.forEach(visit);
  return packages.size === 1 ? [...packages][0] : undefined;
}

/** Whether every node of the dump lies inside the requested display's real size. */
function fitsDisplay(
  nodes: readonly ViewHierarchyNode[],
  size: { width: number; height: number },
): boolean {
  return nodes.every((node) => {
    const bounds = node.bounds;
    return (
      (!bounds ||
        (bounds.left >= 0 &&
          bounds.top >= 0 &&
          bounds.right <= size.width &&
          bounds.bottom <= size.height)) &&
      fitsDisplay(node.node ?? [], size)
    );
  });
}

type DisplaySize = { width: number; height: number };

/**
 * The current display-service records: `dumpsys display` prints them in its Logical Displays
 * section; the `Display id <n>:` rows `cmd display get-displays` prints are read too.
 */
function currentDisplayInfos(dumpsysDisplay: string): AndroidDisplayInfo[] {
  const logical = parseDumpsysLogicalDisplays(dumpsysDisplay, { current: true });
  return logical.length ? logical : parseAndroidDisplayInfos(dumpsysDisplay);
}

/** The requested display's current size, and the default display's for the identity check. */
async function readDisplayGeometry(
  displayId: number,
  execute: ReturnType<typeof boundedDumpExecutor>,
): Promise<{ size: DisplaySize; defaultSize?: DisplaySize }> {
  const infos = currentDisplayInfos((await execute(["shell", "dumpsys", "display"])).stdout);
  const info = infos.find((entry) => entry.logicalId === String(displayId));
  if (info && isAccessibilityUntrackedDisplay(info)) {
    // UIAutomator reads through accessibility too: on a private virtual display it dumps the
    // default display's content, so do not run it.
    throw new UntrackedAndroidDisplayError(displayId, {
      uniqueId: info.uniqueId,
      ownerPackage: info.ownerPackage,
    });
  }
  const size = info?.sizePx;
  if (!size || size.width <= 0 || size.height <= 0) {
    throw new ActionableError(`Display ${displayId} has no readable size in dumpsys display`);
  }
  return { size, defaultSize: infos.find((entry) => entry.logicalId === "0")?.sizePx };
}

/**
 * Why a dump cannot be shown to come from the requested display, or undefined when it can. Some
 * releases ignore `--display` and dump the default display, so fitting inside the display is not
 * enough: a top-level window must span the display exactly, and the display must differ in size
 * from the default display, whose content would otherwise pass the same check.
 */
function dumpIdentityRefusal(
  nodes: readonly ViewHierarchyNode[],
  displayId: number,
  { size, defaultSize }: { size: DisplaySize; defaultSize?: DisplaySize },
): string | undefined {
  const dimensions = `${size.width}x${size.height}`;
  if (!fitsDisplay(nodes, size)) {
    return `UIAutomator dump does not fit display ${displayId} (${dimensions}); this Android release likely ignores --display`;
  }
  const spans = nodes.some(
    ({ bounds }) =>
      bounds?.left === 0 &&
      bounds.top === 0 &&
      bounds.right === size.width &&
      bounds.bottom === size.height,
  );
  if (!spans) {
    return `UIAutomator dump has no window spanning display ${displayId} (${dimensions}), so it cannot be shown to come from that display`;
  }
  if (!defaultSize || (defaultSize.width === size.width && defaultSize.height === size.height)) {
    return `Display ${displayId} (${dimensions}) cannot be told apart from the default display by size, so a UIAutomator dump cannot be shown to come from it`;
  }
  return undefined;
}

/** Read an untracked non-default display without borrowing the default display's foreground app. */
export async function readAndroidDisplayHierarchy(
  displayId: number,
  deps: AndroidHierarchyFallbackDeps,
  deadline: number,
  signal?: AbortSignal,
): Promise<ViewHierarchyResult> {
  const path = dumpPath(deps.idGenerator);
  const execute = boundedDumpExecutor(deps, { deadline, signal });
  try {
    const geometry = await readDisplayGeometry(displayId, execute);
    const { size } = geometry;
    const result = await withDumpLock(deps, { deadline, signal }, async () => {
      await execute(["shell", "uiautomator", "dump", "--display", String(displayId), path]);
      return execute(["shell", "cat", path]);
    });
    const parsed: { hierarchy?: XmlNode } = await parseStringPromise(result.stdout, {
      explicitArray: true,
    });
    throwIfAborted(signal);
    const nodes = missingXmlNodes(parsed.hierarchy?.node ?? [], new Set());
    if (!nodes.length || deps.timer.now() >= deadline) {
      throw new ActionableError(`UIAutomator returned no hierarchy for display ${displayId}`);
    }
    const refusal = dumpIdentityRefusal(nodes, displayId, geometry);
    if (refusal) {
      throw new ActionableError(refusal);
    }
    const packageName = soleXmlPackage(nodes);
    return {
      hierarchy: { node: nodes.length === 1 ? nodes[0] : { $: {}, node: nodes } },
      displayId,
      screenWidth: size.width,
      screenHeight: size.height,
      ...(packageName ? { packageName } : {}),
      sources: ["uiautomator"],
      fresh: false,
    };
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof UntrackedAndroidDisplayError) {
      throw error;
    }
    throw toActionableError(error, `Failed to read display ${displayId} with UIAutomator`);
  } finally {
    await removeDump(deps, path, deadline, signal);
  }
}
