export function parseCommandArgs(command: string): string[] {
  const trimmed = command.trim();
  const isWindows = process.platform === "win32";
  if (trimmed.startsWith("shell ")) {
    let shellCommand = trimmed.slice(6).trim();
    if (
      (shellCommand.startsWith('"') && shellCommand.endsWith('"')) ||
      (shellCommand.startsWith("'") && shellCommand.endsWith("'"))
    ) {
      shellCommand = shellCommand.slice(1, -1);
    }
    return ["shell", shellCommand];
  }

  return parseNonShellCommandArgs(trimmed, isWindows);
}
export function consumeCommandQuoteOrEscape(
  char: string,
  state: CommandArgState,
  isWindows: boolean,
): boolean {
  if (state.escape) {
    state.current += char;
    state.escape = false;
    return true;
  }

  if (!isWindows && char === "\\" && !state.inSingle) {
    state.escape = true;
    return true;
  }

  if (char === "'" && !state.inDouble) {
    state.inSingle = !state.inSingle;
    return true;
  }

  if (char === '"' && !state.inSingle) {
    state.inDouble = !state.inDouble;
    return true;
  }

  return false;
}
export function parseNonShellCommandArgs(trimmed: string, isWindows: boolean): string[] {
  const args: string[] = [];
  const state: CommandArgState = { current: "", inSingle: false, inDouble: false, escape: false };

  for (const char of trimmed) {
    if (consumeCommandQuoteOrEscape(char, state, isWindows)) {
      continue;
    }

    if (!state.inSingle && !state.inDouble && /\s/.test(char)) {
      if (state.current.length > 0) {
        args.push(state.current);
        state.current = "";
      }
      continue;
    }

    state.current += char;
  }

  if (state.current.length > 0) {
    args.push(state.current);
  }

  return args;
}

interface CommandArgState {
  current: string;
  inSingle: boolean;
  inDouble: boolean;
  escape: boolean;
}
