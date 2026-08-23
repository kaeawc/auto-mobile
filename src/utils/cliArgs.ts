/**
 * Read the value for the first matching flag from an argv array, supporting
 * both the space-separated `--flag value` and inline `--flag=value` forms.
 *
 * For the space-separated form, a following token that is itself a flag
 * (starts with `--`) is treated as a missing value and yields `undefined`,
 * so `--flag --other` does not swallow `--other` as the value.
 *
 * @param args - argv tokens (excluding the node/script prefix)
 * @param flags - flag names to match (e.g. `["--tool-outputs-dir", "--tool-output-dir"]`)
 * @returns the resolved value, or `undefined` if no flag matched or its value was missing
 */
export function firstFlagValue(args: string[], flags: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (flags.includes(arg)) {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) {
        return undefined;
      }
      return value;
    }
    const matched = flags.find((flag) => arg.startsWith(`${flag}=`));
    if (matched) {
      return arg.slice(matched.length + 1);
    }
  }
  return undefined;
}
