import { createHash } from "node:crypto";
import path from "node:path";
import { ActionableError } from "../models/ActionableError";
import { fileStem } from "../features/prototype/protoViewer/protoViewerShare";
import type { PrototypeWebResourceQuery } from "../features/prototype/web/prototypeWebResource";
import type { ResourceContent } from "./resourceRegistry";

/**
 * Writes the `automobile:prototype/<id>/web` page to a file (#17720). The page comes from the
 * resource's own reader, so the file holds exactly the bytes a resource read returns.
 */

/** What an existing path is, or undefined when nothing is there. */
export type PrototypeWebExportPathKind = "file" | "directory" | "other";

/** Where the export writes; injected so tests never touch the real filesystem. */
export interface PrototypeWebExportFiles {
  /** Absolute directory used when no outputPath is given. */
  defaultDir(): string;
  kind(filePath: string): Promise<PrototypeWebExportPathKind | undefined>;
  read(filePath: string): Promise<Uint8Array>;
  /** Creates parent directories; `exclusive` fails with EEXIST when the file already exists. */
  write(filePath: string, bytes: Uint8Array, options: { exclusive: boolean }): Promise<void>;
}

export interface PrototypeWebExportDependencies {
  /** The web resource read for these parameters. */
  readWeb(query: PrototypeWebResourceQuery): Promise<ResourceContent>;
  files: PrototypeWebExportFiles;
}

export interface PrototypeWebExportInput extends PrototypeWebResourceQuery {
  /** Absolute `.html` file path, or a directory (existing, or ending in a separator). */
  readonly outputPath?: string;
  readonly overwrite?: boolean;
}

export interface PrototypeWebExportResult {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly frame: string;
  readonly revision: number;
  readonly variants: readonly string[];
  readonly rendererVersion: string;
}

interface WebMeta {
  readonly frame: string;
  readonly revision: number;
  readonly variants: readonly string[];
  readonly rendererVersion: string;
}

function webMeta(content: ResourceContent): WebMeta {
  const meta = content._meta ?? {};
  const { frame, revision, variants, rendererVersion } = meta;
  if (
    typeof frame !== "string" ||
    typeof revision !== "number" ||
    !Array.isArray(variants) ||
    typeof rendererVersion !== "string" ||
    typeof content.text !== "string"
  ) {
    throw new ActionableError(
      `The prototype web page for ${content.uri} came back without its HTML or metadata; nothing was written.`,
    );
  }
  return { frame, revision, variants: variants.map(String), rendererVersion };
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function defaultFileName(input: PrototypeWebExportInput, meta: WebMeta, sha256: string): string {
  const stem = fileStem(input.variant ?? input.id);
  return `${stem}-${meta.frame}-r${meta.revision}-${sha256.slice(0, 12)}.html`;
}

/** The file to write: outputPath itself, or the default name inside the directory it names. */
async function targetPath(
  input: PrototypeWebExportInput,
  files: PrototypeWebExportFiles,
  fileName: string,
): Promise<string> {
  const outputPath = input.outputPath;
  if (outputPath === undefined) {
    return path.join(files.defaultDir(), fileName);
  }
  if (!path.isAbsolute(outputPath)) {
    throw new ActionableError(
      `outputPath "${outputPath}" is not absolute: give an absolute file or directory path, or omit outputPath to write under ${files.defaultDir()}.`,
    );
  }
  const kind = await files.kind(outputPath);
  if (kind === "directory" || /[\\/]$/.test(outputPath)) {
    return path.join(outputPath, fileName);
  }
  if (kind === "other") {
    throw new ActionableError(
      `outputPath "${outputPath}" exists and is not a regular file or directory; choose another outputPath.`,
    );
  }
  if (path.extname(outputPath).toLowerCase() !== ".html") {
    throw new ActionableError(
      `outputPath "${outputPath}" is neither an .html file nor a directory: end a file path in .html, or end a directory path in "${path.sep}" (or name an existing directory) to write ${fileName} there.`,
    );
  }
  return outputPath;
}

function refusedOverwrite(filePath: string): ActionableError {
  return new ActionableError(
    `${filePath} already exists with different content; pass overwrite: true to replace it, or choose another outputPath. Nothing was written.`,
  );
}

const UNWRITABLE_CODES = new Set(["EACCES", "EPERM", "EROFS", "ENOENT", "ENOTDIR", "EISDIR"]);

function writeError(error: unknown, filePath: string): ActionableError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EEXIST") {
    return refusedOverwrite(filePath);
  }
  const reason = code !== undefined && UNWRITABLE_CODES.has(code) ? ` (${code})` : "";
  const detail = error instanceof Error ? `: ${error.message}` : "";
  return new ActionableError(
    `Cannot write the prototype web page to ${filePath}${reason}${detail}. Choose a writable outputPath, or omit it to write under the AutoMobile data directory.`,
  );
}

/** Writes the page unless an unrelated file is in the way; the same bytes already there are kept. */
async function writePage(
  files: PrototypeWebExportFiles,
  filePath: string,
  bytes: Uint8Array,
  overwrite: boolean,
): Promise<void> {
  if ((await files.kind(filePath)) === "file" && !overwrite) {
    const existing = await files.read(filePath);
    if (Buffer.from(existing).equals(Buffer.from(bytes))) {
      return;
    }
    throw refusedOverwrite(filePath);
  }
  try {
    await files.write(filePath, bytes, { exclusive: !overwrite });
  } catch (error) {
    throw writeError(error, filePath);
  }
}

export async function exportPrototypeWeb(
  input: PrototypeWebExportInput,
  deps: PrototypeWebExportDependencies,
): Promise<PrototypeWebExportResult> {
  const { id, frame, revision, variant, mcpSessionId } = input;
  const content = await deps.readWeb({ id, frame, revision, variant, mcpSessionId });
  const meta = webMeta(content);
  const bytes = Buffer.from(content.text!, "utf8");
  const sha256 = sha256Hex(bytes);
  const filePath = await targetPath(input, deps.files, defaultFileName(input, meta, sha256));
  await writePage(deps.files, filePath, bytes, input.overwrite === true);
  return {
    path: filePath,
    sha256,
    bytes: bytes.length,
    frame: meta.frame,
    revision: meta.revision,
    variants: meta.variants,
    rendererVersion: meta.rendererVersion,
  };
}
