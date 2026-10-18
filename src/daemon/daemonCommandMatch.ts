import { isDaemonEntryScriptPath } from "./DaemonLauncher";

export function isShellCommandWrapper(command: string): boolean {
  const normalizedCommand = normalizeProcessCommand(command);
  const trimmedCommand = normalizedCommand.trim();
  const executable = trimmedCommand.startsWith('"')
    ? trimmedCommand.slice(1, trimmedCommand.indexOf('"', 1))
    : (trimmedCommand.split(/\s+/, 1)[0] ?? "");

  if (/(^|\/)(?:ba|da|z)?sh$/.test(executable) && normalizedCommand.includes(" -c ")) {
    return true;
  }

  if (/(^|\/)cmd(?:\.exe)?$/i.test(executable) && /(?:^|\s)\/c(?:\s|$)/i.test(normalizedCommand)) {
    return true;
  }

  return (
    /(^|\/)(?:powershell|pwsh)(?:\.exe)?$/i.test(executable) &&
    /(?:^|\s)-(?:command|encodedcommand|c|ec)(?:\s|$)/i.test(normalizedCommand)
  );
}

function normalizeProcessCommand(command: string): string {
  return command.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function invokedCommand(command: string): string {
  if (!isShellCommandWrapper(command)) {
    return command.trim();
  }

  const shellInvocation = command
    .trim()
    .match(/(?:^|\s)(?:-c|\/c|-(?:command|encodedcommand|c|ec))\s+["']?(.+)$/i);
  return shellInvocation?.[1].trim() ?? command.trim();
}

export function isAutoMobileDaemonCommand(
  command: string,
  activeEntryScript: string | undefined = process.argv[1],
): boolean {
  const normalizedCommand = normalizeProcessCommand(command);
  const invocation = invokedCommand(normalizedCommand);
  if (!/(?:^|\s)--daemon-mode(?:\s|["']|$)/.test(invocation)) {
    return false;
  }

  // Runtime flags are allowed only in the contiguous run immediately after the
  // anchored executable. Bare separators, the daemon marker, and non-flag values
  // are not skipped, so the next token remains the sole entry-script candidate.
  const runtimeEntrypoint = invocation.match(
    /^(?:(?:"?(?:env|\/usr\/bin\/env)"?)\s+)?(?:"(?:[^"]*\/)?(?:bun|node)(?:\.exe)?"|(?:(?:[A-Za-z]:\/[^"']*\/|[^"'\s]*\/)?(?:bun|node)(?:\.exe)?))\s+(?:(?!--daemon-mode(?:\s|$))-{1,2}[A-Za-z0-9][^\s"']*\s+)*(?:"([^"]+)"|'([^']+)'|([^\s"']+))/i,
  );
  const runsBundledEntrypoint =
    runtimeEntrypoint !== null &&
    isDaemonEntryScriptPath(
      runtimeEntrypoint[1] ?? runtimeEntrypoint[2] ?? runtimeEntrypoint[3],
      activeEntryScript,
    );
  const runsPublishedPackage =
    /^(?:"?[^"'\s]*\/)?(?:bunx|npx)(?:\.exe)?\s+(?:(?:-y|--yes|--bun|--no-cache)\s+)*@kaeawc\/auto-mobile(?:@[^\s"']+)?(?:\s|["']|$)/.test(
      invocation,
    ) ||
    /^(?:"?[^"'\s]*\/)?bun(?:\.exe)?\s+x\s+(?:(?:-y|--yes|--bun|--no-cache)\s+)*@kaeawc\/auto-mobile(?:@[^\s"']+)?(?:\s|["']|$)/.test(
      invocation,
    );
  const runsStandaloneBinary = /^(?:"?[^"'\s]*\/)?auto-mobile(?:\.exe)?(?:\s|$)/i.test(invocation);

  return runsBundledEntrypoint || runsPublishedPackage || runsStandaloneBinary;
}
