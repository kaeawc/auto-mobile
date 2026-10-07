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

/**
 * Known removed actions of tools that still exist, keyed by tool then action, with what to use
 * instead. The tool's own action validation reports the hint, so callers see why the action is gone.
 */
export const REMOVED_TOOL_ACTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  overlay: {
    showVariants:
      "show with one design at a time (describe the alternatives in chat and ask which the user prefers), or one show spec whose pager holds every design",
    update:
      "show with the full spec; a show with the same id replaces it in place and keeps its display and pager pages (reset: true starts fresh)",
  },
};

export function getRemovedToolActionHint(toolName: string, action: unknown): string | undefined {
  if (typeof action !== "string") {
    return undefined;
  }
  const actions = REMOVED_TOOL_ACTIONS[toolName];
  const replacement = actions && Object.hasOwn(actions, action) ? actions[action] : undefined;
  return replacement ? `${toolName} action ${action} was removed; use ${replacement}` : undefined;
}
