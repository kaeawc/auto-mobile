/** Known removed MCP tools and the supported tool to use in their place. */
export const REMOVED_TOOLS: Readonly<Record<string, string>> = {
  captureScreenshot: 'observe {screenshot:"settled"} (returns screenshotPath)',
  inputText: "sendKeys",
  clearText: "sendKeys",
  imeAction: "sendKeys",
  debugSearch: "observe to see elements, and the diagnostics returned by tapOn/waitFor failures",
  stageSharedStorage:
    "putAppFile with target.domain user_files (move namespace/reset/indexMedia into target; set indexMedia true to keep the old default)",
  stageSharedStorageFixtures:
    "putAppFile with target.domain user_files (move namespace/reset/indexMedia into target; set indexMedia true to keep the old default)",
};

export function getRemovedToolReplacement(toolName: string): string | undefined {
  return REMOVED_TOOLS[toolName];
}

export function getRemovedToolHint(toolName: string): string | undefined {
  const replacement = getRemovedToolReplacement(toolName);
  return replacement ? `${toolName} was removed; use ${replacement}` : undefined;
}
