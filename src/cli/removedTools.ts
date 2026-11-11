import { getRemovedToolHint } from "../utils/removedTools";

export function formatDaemonToolError(
  toolName: string,
  message: string,
  options: { buildSkew?: boolean } = {},
): string {
  const hint = getRemovedToolHint(toolName);
  if (hint && /Unknown tool\b/i.test(message)) {
    return hint;
  }

  const detail = message.replace(/[.]+$/, "");
  // Only detected client/daemon build skew is fixed by a restart: an unknown tool name (#18024)
  // or a gated tool (#10177) is the same after one.
  const restartHint = options.buildSkew ? " Try: auto-mobile --daemon restart" : "";
  return `Error calling daemon: ${detail}.${restartHint}`;
}
