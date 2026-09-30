/** Known removed MCP tools and the supported tool to use in their place. */
export const REMOVED_TOOLS: Readonly<Record<string, string>> = {
  captureScreenshot: 'observe {screenshot:"settled"} (returns screenshotPath)',
  inputText: "sendKeys",
  clearText: "sendKeys",
  imeAction: "sendKeys",
};

export function getRemovedToolReplacement(toolName: string): string | undefined {
  return REMOVED_TOOLS[toolName];
}

export function formatDaemonToolError(toolName: string, message: string): string {
  const replacement = getRemovedToolReplacement(toolName);
  if (replacement && /Unknown tool\b/i.test(message)) {
    return `${toolName} was removed; use ${replacement}`;
  }

  const detail = message.replace(/[.]+$/, "");
  const restartHint = /Unknown tool\b/i.test(message) ? " Try: auto-mobile --daemon restart" : "";
  return `Error calling daemon: ${detail}.${restartHint}`;
}
