import { getRemovedToolHint } from "../models/removedTools";

export function formatDaemonToolError(toolName: string, message: string): string {
  const hint = getRemovedToolHint(toolName);
  if (hint && /Unknown tool\b/i.test(message)) {
    return hint;
  }

  const detail = message.replace(/[.]+$/, "");
  const restartHint = /Unknown tool\b/i.test(message) ? " Try: auto-mobile --daemon restart" : "";
  return `Error calling daemon: ${detail}.${restartHint}`;
}
