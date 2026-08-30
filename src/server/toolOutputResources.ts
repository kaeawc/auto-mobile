import path from "node:path";
import * as realFs from "node:fs/promises";
import { ResourceRegistry, type ResourceContent } from "./resourceRegistry";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import { serverConfig } from "../utils/ServerConfig";
import { getDefaultToolOutputsDir } from "../utils/toolOutputArtifacts";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../utils/workingDirectory";

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
 * then at least one `-`-joined segment, then `.json` — so a crafted `artifactId`
 * can never escape the tool-outputs directory (no separators, no `..`) AND an
 * arbitrary sibling file in a shared/misconfigured `--tool-outputs-dir` (e.g.
 * `credentials.json`) is not served just because it ends in `.json` (issue #5882
 * review). This narrows the readable namespace to the writer's own emissions; it
 * is not full per-artifact provenance tracking (deferred — see #5917).
 */
const SAFE_ARTIFACT_ID = /^\d+-[A-Za-z0-9._-]+\.json$/;

interface ToolOutputResourceFileSystem {
  readFile(filePath: string): Promise<string>;
}

const nodeToolOutputResourceFileSystem: ToolOutputResourceFileSystem = {
  async readFile(filePath: string): Promise<string> {
    return realFs.readFile(filePath, "utf8");
  },
};

let toolOutputResourceFileSystem: ToolOutputResourceFileSystem = nodeToolOutputResourceFileSystem;
let resolveToolOutputsDir: () => string = defaultResolveToolOutputsDir;

export function setToolOutputResourceDependencies(deps: {
  fileSystem?: ToolOutputResourceFileSystem;
  resolveDirectory?: () => string;
}): void {
  if (deps.fileSystem) {
    toolOutputResourceFileSystem = deps.fileSystem;
  }
  if (deps.resolveDirectory) {
    resolveToolOutputsDir = deps.resolveDirectory;
  }
}

export function resetToolOutputResourceDependencies(): void {
  toolOutputResourceFileSystem = nodeToolOutputResourceFileSystem;
  resolveToolOutputsDir = defaultResolveToolOutputsDir;
}

/**
 * Resolve the tool-outputs directory the way the writer does: the configured
 * directory when set, else the default temp subdir, then normalized against the
 * daemon launch cwd (idempotent for the already-absolute default).
 */
function defaultResolveToolOutputsDir(): string {
  const configured = serverConfig.getToolOutputsDir();
  return resolvePathFromDaemonLaunchWorkingDirectory(configured ?? getDefaultToolOutputsDir());
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

async function getToolOutputArtifact(params: Record<string, string>): Promise<ResourceContent> {
  const artifactId = params.artifactId ?? "";
  const uri = buildToolOutputResourceUri(artifactId);

  if (!SAFE_ARTIFACT_ID.test(artifactId)) {
    return toolOutputError(
      uri,
      `Invalid tool-output artifact id "${artifactId}". Expected a "<name>.json" basename with no path separators.`,
    );
  }

  // `SAFE_ARTIFACT_ID` is a strict allowlist with no path separators, so the join
  // can never escape `directory` — no dirname re-check is needed. (An earlier
  // `path.dirname(filePath) !== directory` guard rejected every read when
  // `--tool-outputs-dir` ended in a separator, since `path.dirname` normalizes
  // the trailing slash away while the configured directory keeps it — issue #5882
  // review.)
  const directory = resolveToolOutputsDir();
  const filePath = path.join(directory, artifactId);

  try {
    const text = await toolOutputResourceFileSystem.readFile(filePath);
    return { uri, mimeType: "application/json", text };
  } catch (error) {
    const reason = errorMessage(error);
    logger.warn(`[ToolOutputResources] Failed to read artifact ${artifactId}: ${reason}`);
    return toolOutputError(
      uri,
      `Tool-output artifact "${artifactId}" is not available. It may have expired or been pruned. Re-run the tool to regenerate it. (${reason})`,
    );
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
