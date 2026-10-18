/** Splits a shell-style command into argv, honouring quotes and backslash escapes. */
export function splitCommandArgs(command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error("Command cannot be empty");
  }

  const args: string[] = [];
  let current = "";
  // A token that was opened with a quote is real even when it is empty — `""`
  // must survive as an empty argv entry. Dropping it shifts every later
  // positional argument, which silently rewrites the command (issue #4196).
  let started = false;
  let quote: '"' | "'" | null = null;

  const flush = (): void => {
    if (started) {
      args.push(current);
      current = "";
      started = false;
    }
  };

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];

    if (char === "\\" && i + 1 < trimmed.length) {
      current += trimmed[i + 1];
      started = true;
      i++;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }

    if (/\s/.test(char)) {
      flush();
      continue;
    }

    current += char;
    started = true;
  }

  flush();

  return args;
}
