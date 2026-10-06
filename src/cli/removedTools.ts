import { getRemovedToolHint } from "../models/removedTools";

export function formatDaemonToolError(
  toolName: string,
  message: string,
  options: { gated?: boolean } = {},
): string {
  const hint = getRemovedToolHint(toolName);
  if (hint && /Unknown tool\b/i.test(message)) {
    return hint;
  }

  const detail = message.replace(/[.]+$/, "");
  // A gated tool (#10177) is daemon configuration, not a stale daemon: a restart cannot lift it.
  const restartHint =
    !options.gated && /Unknown tool\b/i.test(message) ? " Try: auto-mobile --daemon restart" : "";
  return `Error calling daemon: ${detail}.${restartHint}`;
}
