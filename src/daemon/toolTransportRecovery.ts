/** Internal index of transport recovery permissions declared by the singleton registry. */
export type ToolTransportRecovery = "connect" | "replay";

const recoveryByTool = new Map<string, ToolTransportRecovery>();

export function setToolTransportRecovery(
  name: string,
  recovery: ToolTransportRecovery | undefined,
): void {
  if (recovery === undefined) {
    recoveryByTool.delete(name);
  } else {
    recoveryByTool.set(name, recovery);
  }
}

export function getToolTransportRecovery(name: string): ToolTransportRecovery | undefined {
  return recoveryByTool.get(name);
}

export function clearToolTransportRecovery(): void {
  recoveryByTool.clear();
}
