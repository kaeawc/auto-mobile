/** Help flags after a command boundary belong to that command's arguments. */
export function hasGlobalHelpFlag(args: string[]): boolean {
  const boundary = args.findIndex((arg) => ["--cli", "--daemon", "--boot-device"].includes(arg));
  const globalArgs = boundary >= 0 ? args.slice(0, boundary) : args;
  return globalArgs.includes("--help") || globalArgs.includes("-h");
}
