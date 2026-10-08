/** Help flags after a command boundary belong to that command's arguments. */
export function hasGlobalHelpFlag(args: string[]): boolean {
  const boundary = args.findIndex((arg) =>
    ["--cli", "--daemon", "--boot-device", "--ios-network-filter"].includes(arg),
  );
  const globalArgs = boundary >= 0 ? args.slice(0, boundary) : args;
  return globalArgs.includes("--help") || globalArgs.includes("-h");
}

/**
 * True when a `--cli` invocation only prints usage (`--cli`, `--cli help [tool]`,
 * `--cli --help|-h`) and never talks to a device, so startup must not kick off
 * CtrlProxy prefetches or other data-directory maintenance for it (#10792).
 */
export function isCliHelpInvocation(cliMode: boolean, cliArgs: string[]): boolean {
  if (!cliMode) {
    return false;
  }
  const [first] = cliArgs;
  return first === undefined || first === "help" || first === "--help" || first === "-h";
}
