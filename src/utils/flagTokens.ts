import { logger } from "./logger";

/** The slice of the logger the flag readers need; `numericValidators`' `ParseLogger` fits it. */
export interface FlagLogger {
  warn(message: string): void;
}

/**
 * The one command-line flag tokenizer. `--flag value` and `--flag=value` are the same flag with
 * the same operand, whoever reads it: validators and readers share these functions so what is
 * "validated" and what is "parsed" cannot disagree (#11612).
 *
 * Rules, in one place:
 * - `--flag=value` splits at the FIRST `=`; the value is explicit and verbatim (it may contain
 *   `=`, be empty, or start with `--`).
 * - `--flag value` takes the next token as its value unless that token starts with `--` (so a
 *   following flag is never swallowed). A negative number such as `-5` is a value.
 * - A bare `--` ends the options: nothing after it is a flag.
 * - Boolean flags never consume a following token. `--flag=true` / `--flag=false` are accepted;
 *   any other inline value is refused.
 * - Node's `util.parseArgs` was evaluated and not used: its strict mode needs every flag of the
 *   shared launch surface declared per command, rejects `--flag=false` for booleans and
 *   `--flag --other` (a missing value that the launcher and relay deliberately tolerate), and its
 *   non-strict mode drops what it cannot classify, which is the defect this module closes.
 */
export const END_OF_OPTIONS = "--";

export interface SplitFlagToken {
  /** The flag name without any `=value`, e.g. `--port`. */
  flag: string;
  /** The text after the first `=`, or undefined when the token has none. */
  inlineValue: string | undefined;
}

/** Split one argv token into its flag name and `=value`; a non-flag token is returned whole. */
export function splitFlagToken(arg: string): SplitFlagToken {
  const equals = arg.indexOf("=");
  if (!arg.startsWith("-") || equals < 2 || arg.slice(0, equals).replace(/^-+/, "") === "") {
    return { flag: arg, inlineValue: undefined };
  }
  return { flag: arg.slice(0, equals), inlineValue: arg.slice(equals + 1) };
}

export interface FlagOperand {
  flag: string;
  /** The flag's value; undefined when `--flag` was last or followed by another flag. */
  value: string | undefined;
  /** True when the value came from `--flag=value` (it is then never rejected for its shape). */
  inline: boolean;
  /** Index of the last argv token this flag consumed. */
  last: number;
}

/** Read the value-taking flag at `args[index]` in either form. */
export function readValueOperand(args: readonly string[], index: number): FlagOperand {
  const { flag, inlineValue } = splitFlagToken(args[index]);
  if (inlineValue !== undefined) {
    return { flag, value: inlineValue, inline: true, last: index };
  }
  const next = args[index + 1];
  const hasValue = next !== undefined && !next.startsWith("--");
  return {
    flag,
    value: hasValue ? next : undefined,
    inline: false,
    last: hasValue ? index + 1 : index,
  };
}

/** Every occurrence, in order, of the value-taking `names` flags; scanning stops at `--`. */
export function findValueOperands(
  args: readonly string[],
  names: readonly string[],
): FlagOperand[] {
  const found: FlagOperand[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === END_OF_OPTIONS) {
      break;
    }
    if (names.includes(splitFlagToken(args[index]).flag)) {
      const operand = readValueOperand(args, index);
      found.push(operand);
      index = operand.last;
    }
  }
  return found;
}

/** The first occurrence of a value-taking flag among `names`, or undefined when absent. */
export function findValueOperand(
  args: readonly string[],
  names: readonly string[],
): FlagOperand | undefined {
  return findValueOperands(args, names)[0];
}

/** `true`/`false` for an inline boolean value, `true` when absent (`--flag`), else undefined. */
export function parseBooleanFlagValue(inlineValue: string | undefined): boolean | undefined {
  if (inlineValue === undefined || inlineValue === "true") {
    return true;
  }
  return inlineValue === "false" ? false : undefined;
}

/**
 * The state of a boolean flag (any of `names`): undefined when absent, otherwise the LAST
 * occurrence's value (`--flag`/`--flag=true` is true, `--flag=false` is false). An inline value
 * that is neither is warned about and ignored; command validators refuse it before this runs.
 */
export function readBooleanFlag(
  args: readonly string[],
  names: readonly string[],
  log: FlagLogger = logger,
): boolean | undefined {
  let state: boolean | undefined;
  for (const arg of args) {
    if (arg === END_OF_OPTIONS) {
      break;
    }
    const { flag, inlineValue } = splitFlagToken(arg);
    if (!names.includes(flag)) {
      continue;
    }
    const parsed = parseBooleanFlagValue(inlineValue);
    if (parsed === undefined) {
      log.warn(`Invalid value for ${flag}: ${inlineValue}; expected true or false`);
    } else {
      state = parsed;
    }
  }
  return state;
}
