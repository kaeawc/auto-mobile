/** The plan tools that rendezvous several device tracks; validation and resume both key on this one set. */
const COORDINATION_TOOLS: ReadonlySet<string> = new Set(["barrier", "criticalSection"]);

export function isCoordinationTool(tool: string): boolean {
  return COORDINATION_TOOLS.has(tool);
}
