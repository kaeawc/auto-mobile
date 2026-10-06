import { Builder, parseStringPromise } from "xml2js";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { ActionableError, toActionableError } from "../../models";
import { errorMessage } from "../../utils/describeUnknownError";
import { shellQuoteUnlessSafe } from "../../utils/shellQuote";

/**
 * Direct on-device XML manipulation for Android SharedPreferences files, shared by
 * `AppPreferences` (the `setPreference`/`getPreference` MCP tools) and the storage
 * key-value tools' fallback path (issue #6292).
 *
 * Both write paths must reach the same `shared_prefs/<file>.xml` via `adb shell run-as`
 * so that a caller who can write a preference through one tool can also delete or clear
 * it through the other — they are the same physical file.
 */

export type AndroidPreferencesXmlDocument = { map: Record<string, unknown> };

/**
 * `run-as <pkg> [--user <id>]` prefix. `run-as` without `--user` targets user 0
 * (AOSP: `usage: run-as <package-name> [--user <uid>] <command> [<args>]`), so the flag is
 * emitted only for nonzero users and a single-user device sends the exact same command as
 * before user targeting existed (issue #9919).
 */
export function androidPreferencesRunAs(appId: string, userId?: number): string {
  return `shell run-as ${shellQuoteUnlessSafe(appId)}${userId ? ` --user ${userId}` : ""}`;
}

function runAsTarget(appId: string, userId?: number): string {
  return userId ? `${appId} (user ${userId})` : appId;
}

/**
 * Validates and normalizes a SharedPreferences file name (without the `.xml` extension).
 */
export function sanitizeAndroidPreferencesFileName(name: string): string {
  const fileName = name.endsWith(".xml") ? name.slice(0, -4) : name;
  if (!/^[A-Za-z0-9_.-]+$/.test(fileName) || fileName === "." || fileName === "..") {
    throw new ActionableError(
      "Android SharedPreferences file name must be a safe file name using letters, numbers, underscore, dash, or dot.",
    );
  }
  return fileName;
}

/**
 * Reads the raw SharedPreferences XML for `appId`/`fileName` via `adb shell run-as`.
 * A missing file (the app has never written this SharedPreferences file yet) reads back
 * as an empty `<map/>` document rather than an error.
 */
export async function readAndroidPreferencesXml(
  adb: AdbExecutor,
  appId: string,
  fileName: string,
  userId?: number,
): Promise<string> {
  try {
    const result = await adb.executeCommand(
      `${androidPreferencesRunAs(appId, userId)} cat shared_prefs/${fileName}.xml`,
    );
    return result.stdout;
  } catch (error) {
    if (looksLikeMissingAndroidPrefsFile(error)) {
      return "<map/>";
    }
    throw new ActionableError(
      `Failed to read Android SharedPreferences via run-as. This requires a debuggable/test build for ${runAsTarget(appId, userId)}. ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

/**
 * Reads a SharedPreferences XML document and retains whether the backing file existed.
 *
 * Adding entries may create a preferences file, while removing an absent entry must remain a
 * no-op. This keeps that policy decision at the mutation seam.
 */
export async function readAndroidPreferencesXmlIfExists(
  adb: AdbExecutor,
  appId: string,
  fileName: string,
  userId?: number,
): Promise<{ xml: string; exists: boolean }> {
  try {
    const result = await adb.executeCommand(
      `${androidPreferencesRunAs(appId, userId)} cat shared_prefs/${fileName}.xml`,
    );
    return { xml: result.stdout, exists: true };
  } catch (error) {
    if (looksLikeMissingAndroidPrefsFile(error)) {
      return { xml: "<map/>", exists: false };
    }
    throw new ActionableError(
      `Failed to read Android SharedPreferences via run-as. This requires a debuggable/test build for ${runAsTarget(appId, userId)}. ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

/**
 * Writes raw SharedPreferences XML for `appId`/`fileName` via `adb shell run-as`.
 */
export async function writeAndroidPreferencesXml(
  adb: AdbExecutor,
  appId: string,
  fileName: string,
  xml: string,
  userId?: number,
): Promise<void> {
  const encodedXml = Buffer.from(xml, "utf8").toString("base64");
  const innerCommand = `mkdir -p shared_prefs && printf '%s' '${encodedXml}' | base64 -d > shared_prefs/${fileName}.xml`;
  try {
    await adb.executeCommand(
      `${androidPreferencesRunAs(appId, userId)} sh -c ${shellQuoteUnlessSafe(innerCommand)}`,
    );
  } catch (error) {
    throw new ActionableError(
      `Failed to write Android SharedPreferences via run-as. This requires a debuggable/test build for ${runAsTarget(appId, userId)}. ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

export async function parseAndroidPreferencesXml(
  xml: string,
): Promise<AndroidPreferencesXmlDocument> {
  const trimmed = xml.trim();
  if (!trimmed) {
    return { map: {} };
  }
  try {
    const parsed = await parseStringPromise(trimmed, {
      explicitArray: true,
      explicitRoot: true,
      trim: false,
      // xml2js deletes the text of any element whose text is whitespace-only (and, for an
      // element with attributes, that is the only copy), so a `<string name="k"> </string>`
      // value reads back as "" (issue #9916). Ordered children + `includeWhiteChars` make the
      // parser also keep every text run as a `__text__` child under `$$`; the legacy
      // `{ $, _, <tag>: [...] }` shape is rebuilt from those by `restoreWhitespaceText`.
      explicitChildren: true,
      preserveChildrenOrder: true,
      charsAsChildren: true,
      includeWhiteChars: true,
    });
    return normalizeAndroidPreferencesDocument(restoreWhitespaceText(parsed));
  } catch (error) {
    throw toActionableError(error, "Failed to parse Android SharedPreferences XML");
  }
}

export function serializeAndroidPreferencesXml(document: AndroidPreferencesXmlDocument): string {
  return new Builder({
    xmldec: { version: "1.0", encoding: "utf-8", standalone: true },
    renderOpts: { pretty: false },
  }).buildObject(document);
}

/** Removes every node named `key` (across all value-type tags) from `document.map`. */
export function removeNamedNodes(document: AndroidPreferencesXmlDocument, key: string): void {
  for (const [tag, nodes] of Object.entries(document.map)) {
    if (Array.isArray(nodes)) {
      document.map[tag] = nodes.filter((node) => node?.$?.name !== key);
    }
  }
}

export function arrayOfNodes(nodes: unknown): any[] {
  if (Array.isArray(nodes)) {
    return nodes;
  }
  if (nodes === undefined || nodes === null) {
    return [];
  }
  return [nodes];
}

export function findNamedNode(nodes: unknown, key: string): any | null {
  return arrayOfNodes(nodes).find((node) => node?.$?.name === key) ?? null;
}

const ORDERED_CHILDREN_KEY = "$$";
const ORDERED_NAME_KEY = "#name";
const ORDERED_TEXT_NAME = "__text__";

/**
 * Collapses the ordered-children bookkeeping that `parseAndroidPreferencesXml` asks xml2js for
 * back into the default `{ $, _, <tag>: [...] }` shape, keeping the text of whitespace-only
 * elements that xml2js would otherwise have dropped. Text-only elements without attributes
 * collapse to plain strings, exactly as xml2js does by default.
 */
function restoreWhitespaceText(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(restoreWhitespaceText);
  }
  if (!isRecord(value)) {
    return value;
  }
  const node: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key !== ORDERED_CHILDREN_KEY && key !== ORDERED_NAME_KEY) {
      node[key] = key === "$" ? child : restoreWhitespaceText(child);
    }
  }
  const text = wholeTextOf(value[ORDERED_CHILDREN_KEY]);
  if (node._ === undefined && text !== undefined) {
    node._ = text;
  }
  return Object.keys(node).length === 1 && typeof node._ === "string" ? node._ : node;
}

/** The concatenated text of an ordered-children list made only of text runs, else undefined. */
function wholeTextOf(children: unknown): string | undefined {
  if (!Array.isArray(children) || children.length === 0) {
    return undefined;
  }
  const runs = children.filter(
    (child) => isRecord(child) && child[ORDERED_NAME_KEY] === ORDERED_TEXT_NAME,
  );
  if (runs.length !== children.length) {
    return undefined;
  }
  return runs.map((run) => String(run._ ?? "")).join("");
}

function normalizeAndroidPreferencesDocument(parsed: unknown): AndroidPreferencesXmlDocument {
  if (!isRecord(parsed)) {
    return { map: {} };
  }
  if (!isRecord(parsed.map)) {
    return { ...parsed, map: {} };
  }
  return parsed as AndroidPreferencesXmlDocument;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeMissingAndroidPrefsFile(error: unknown): boolean {
  const message = errorMessage(error);
  if (!/No such file|not found|does not exist/i.test(message)) {
    return false;
  }
  return /shared_prefs\/[^/\s]+\.xml/i.test(message);
}
