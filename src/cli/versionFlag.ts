export function hasGlobalVersionFlag(args: string[]): boolean {
  const cliIndex = args.indexOf("--cli");
  const globalArgs = cliIndex >= 0 ? args.slice(0, cliIndex) : args;
  return globalArgs.includes("--version") || globalArgs.includes("-v");
}
