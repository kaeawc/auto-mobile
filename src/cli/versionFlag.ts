export function hasGlobalVersionFlag(args: string[]): boolean {
  const commandBoundaryIndex = args.findIndex(arg => arg === "--cli" || arg === "--daemon");
  const globalArgs = commandBoundaryIndex >= 0 ? args.slice(0, commandBoundaryIndex) : args;
  return globalArgs.includes("--version") || globalArgs.includes("-v");
}
