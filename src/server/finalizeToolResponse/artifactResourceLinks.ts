import { isRecord } from "../pipeline/isRecord";

/** The MCP `resource_link` content block (spec 2025-06-18). */
export interface ResourceLinkBlock {
  type: "resource_link";
  uri: string;
  name: string;
  mimeType: string;
  size: number;
}

/** The `payload` label the hard-ceiling spill gives a whole oversized tool response. */
const SPILLED_RESPONSE_PAYLOAD = "ToolResponse";

/**
 * The `resource_link` block for a response whose complete payload was spilled to a tool-output
 * artifact because it exceeded the inline ceiling (#13942): `{ artifact: { resourceUri, bytes,
 * tool, payload: "ToolResponse" } }` at the top level. The pointer in the payload text stays, so a
 * client that ignores link blocks loses nothing; one that follows them can fetch the artifact
 * through the protocol. Observation artifacts are deliberately not linked: they accompany most
 * observe and action results and stay on the existing pointer.
 */
export function artifactResourceLinks(payload: unknown): ResourceLinkBlock[] {
  const artifact = isRecord(payload) ? payload.artifact : undefined;
  if (
    !isRecord(artifact) ||
    typeof artifact.resourceUri !== "string" ||
    artifact.payload !== SPILLED_RESPONSE_PAYLOAD
  ) {
    return [];
  }
  const tool = typeof artifact.tool === "string" ? artifact.tool : "tool";
  return [
    {
      type: "resource_link",
      uri: artifact.resourceUri,
      name: `${tool} full response`,
      mimeType: "application/json",
      size: typeof artifact.bytes === "number" ? artifact.bytes : 0,
    },
  ];
}

/** Append the links an envelope does not already carry. */
export function appendArtifactResourceLinks(
  envelope: { content?: Array<Record<string, unknown>> },
  payload: unknown,
  internal: boolean,
): void {
  if (internal || !Array.isArray(envelope.content)) {
    return;
  }
  const present = new Set(
    envelope.content.flatMap((part) =>
      part?.type === "resource_link" && typeof part.uri === "string" ? [part.uri] : [],
    ),
  );
  for (const link of artifactResourceLinks(payload)) {
    if (!present.has(link.uri)) {
      envelope.content.push({ ...link });
    }
  }
}
