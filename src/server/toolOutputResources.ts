import * as realFs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { ResourceRegistry, type ResourceContent } from "./resourceRegistry";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import {
  toolOutputArtifactLedger,
  type ToolOutputArtifactLedger,
} from "./toolOutputArtifactLedger";

/**
 * In-band fetch for tool-output artifacts (issue #5882). Large observe/action
 * payloads spill to a host file under the tool-outputs directory and are replaced
 * on the wire with `{ artifact: { path, resourceUri, ... } }`. `path` is a host
 * filesystem path a remote MCP client cannot read; `resourceUri` is its companion
 * — an `automobile:` resource that returns the same JSON in-band over the
 * protocol, so `raw:true` (and every other artifacted output) is fetchable
 * without filesystem access.
 */
export const TOOL_OUTPUT_RESOURCE_URI_TEMPLATE = "automobile:tool-output/{artifactId}";

const TOOL_OUTPUT_RESOURCE_URI_PREFIX = "automobile:tool-output/";

/**
 * Artifact filenames are `${timestamp}-${tool}-${id}.json`, where the tool/id
 * segments are already restricted to `[A-Za-z0-9._-]` by `safeFilenameSegment`
 * in the writer. Match the writer's full shape — a leading numeric timestamp,
 * then at least one `-`-joined segment, then `.json` — as a cheap first gate that
 * rejects a crafted `artifactId` (no separators, no `..`) with a clear message.
 * Provenance (the issued-artifact ledger below) is the actual authorization: a
 * shape-valid id that the writer never issued is still refused (issue #5917).
 */
const SAFE_ARTIFACT_ID = /^\d+-[A-Za-z0-9._-]+\.json$/;

interface ToolOutputResourceFileSystem {
  readFile(filePath: string, sha256?: string): Promise<string>;
}

// O_NOFOLLOW is POSIX-only; on platforms without it (Windows) the flag is
// absent, so fall back to a plain read-only open there.
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

const nodeToolOutputResourceFileSystem: ToolOutputResourceFileSystem = {
  async readFile(filePath: string, sha256?: string): Promise<string> {
    // `filePath` comes from the provenance ledger — a value the writer itself
    // constructed, never the client-supplied id — so a shared/misconfigured
    // `--tool-outputs-dir` cannot steer this read to an arbitrary sibling.
    // Opening with O_NOFOLLOW refuses a planted symlink, and reading through the
    // single returned handle (stat + read on the same fd) closes the check-then
    // -read TOCTOU window (issue #5917).
    const handle = await realFs.open(filePath, fsConstants.O_RDONLY | O_NOFOLLOW);
    let text: string;
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        throw new Error(`tool-output artifact is not a regular file: ${filePath}`);
      }
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    // Authorize by the content hash captured at creation: verify the exact bytes
    // we are about to return, so no replacement at the recorded path — regular-
    // file swap or inode-reuse alias, both of which a path/dev-ino check misses —
    // can get its bytes served (issue #5917 review).
    if (sha256 !== undefined) {
      const actual = createHash("sha256").update(text, "utf8").digest("hex");
      if (actual !== sha256) {
        throw new Error(`tool-output artifact content hash mismatch: ${filePath}`);
      }
    }
    return text;
  },
};

let toolOutputResourceFileSystem: ToolOutputResourceFileSystem = nodeToolOutputResourceFileSystem;
let issuedArtifactLedger: Pick<ToolOutputArtifactLedger, "resolve"> = toolOutputArtifactLedger;

export function setToolOutputResourceDependencies(deps: {
  fileSystem?: ToolOutputResourceFileSystem;
  ledger?: Pick<ToolOutputArtifactLedger, "resolve">;
}): void {
  if (deps.fileSystem) {
    toolOutputResourceFileSystem = deps.fileSystem;
  }
  if (deps.ledger) {
    issuedArtifactLedger = deps.ledger;
  }
}

export function resetToolOutputResourceDependencies(): void {
  toolOutputResourceFileSystem = nodeToolOutputResourceFileSystem;
  issuedArtifactLedger = toolOutputArtifactLedger;
}

/** Build the companion resource URI for an artifact file basename. */
export function buildToolOutputResourceUri(filename: string): string {
  return `${TOOL_OUTPUT_RESOURCE_URI_PREFIX}${filename}`;
}

function toolOutputError(uri: string, error: string): ResourceContent {
  return {
    uri,
    mimeType: "application/json",
    text: JSON.stringify({ error }, null, 2),
  };
}

function notAvailable(uri: string, artifactId: string, detail?: string): ResourceContent {
  const suffix = detail ? ` (${detail})` : "";
  return toolOutputError(
    uri,
    `Tool-output artifact "${artifactId}" is not available. It may have expired or been ` +
      `pruned, or it was not issued by this server. Re-run the tool to regenerate it.${suffix}`,
  );
}

async function getToolOutputArtifact(params: Record<string, string>): Promise<ResourceContent> {
  const artifactId = params.artifactId ?? "";
  const uri = buildToolOutputResourceUri(artifactId);

  if (!SAFE_ARTIFACT_ID.test(artifactId)) {
    return toolOutputError(
      uri,
      `Invalid tool-output artifact id "${artifactId}". Expected a "<name>.json" basename with no path separators.`,
    );
  }

  // Provenance gate: only serve files the writer actually issued, and read the
  // path the writer recorded rather than one re-derived from the client id. A
  // shape-valid sibling planted in a shared `--tool-outputs-dir` has no ledger
  // entry, so it is refused before any filesystem access (issue #5917).
  const issued = issuedArtifactLedger.resolve(artifactId);
  if (issued === undefined) {
    return notAvailable(uri, artifactId);
  }

  try {
    const text = await toolOutputResourceFileSystem.readFile(issued.path, issued.sha256);
    return { uri, mimeType: "application/json", text };
  } catch (error) {
    const reason = errorMessage(error);
    logger.warn(`[ToolOutputResources] Failed to read artifact ${artifactId}: ${reason}`);
    return notAvailable(uri, artifactId, reason);
  }
}

export function registerToolOutputResources(): void {
  ResourceRegistry.registerTemplate(
    TOOL_OUTPUT_RESOURCE_URI_TEMPLATE,
    "Tool Output Artifact",
    "In-band fetch for a tool-output artifact that spilled to a host file. The " +
      "`resourceUri` in an artifact's metadata points here so a client can read the " +
      'full raw JSON (e.g. an `observe {"raw": true}` hierarchy) over the protocol.',
    "application/json",
    getToolOutputArtifact,
  );

  logger.info("[ToolOutputResources] Registered tool-output artifact resource");
}
