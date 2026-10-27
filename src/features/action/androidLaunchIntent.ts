import { ActionableError } from "../../models/ActionableError";
import { shellQuote } from "../../utils/shellQuote";

/** One typed `am start` extra (#14080). */
export type AndroidIntentExtra =
  | { key: string; type: "string"; value: string }
  | { key: string; type: "int" | "long" | "float"; value: number }
  | { key: string; type: "boolean"; value: boolean }
  | { key: string; type: "stringArray"; value: string[] }
  | { key: string; type: "uri"; value: string };

export type AndroidIntentFlag = "clearTask" | "newTask" | "singleTop" | "clearTop" | "noHistory";

/** The Android launch intent `launchApp` builds into `am start` arguments (#14080). */
export interface AndroidLaunchIntent {
  /** ".DebugActivity", "com.example.app.DebugActivity" or "com.example.app/.DebugActivity". */
  component?: string;
  action?: string;
  data?: string;
  mimeType?: string;
  categories?: string[];
  extras?: AndroidIntentExtra[];
  flags?: AndroidIntentFlag[];
}

export type AndroidLaunchIntentErrorCode =
  | "invalid_intent"
  | "activity_not_exported"
  | "activity_not_found"
  | "intent_unresolved"
  | "am_start_failed";

/** A typed intent-launch failure; the code also leads the message for clients that read text. */
export class AndroidLaunchIntentError extends ActionableError {
  constructor(
    readonly code: AndroidLaunchIntentErrorCode,
    detail: string,
  ) {
    super(`[${code}] ${detail}`);
  }
}

const EXTRA_FLAGS: Record<AndroidIntentExtra["type"], string> = {
  string: "--es",
  int: "--ei",
  long: "--el",
  float: "--ef",
  boolean: "--ez",
  stringArray: "--esa",
  uri: "--eu",
};

/** `am start` has dedicated options for these; FLAG_ACTIVITY_NEW_TASK has none, so it is `-f`. */
const FLAG_OPTIONS: Record<Exclude<AndroidIntentFlag, "newTask">, string> = {
  clearTask: "--activity-clear-task",
  singleTop: "--activity-single-top",
  clearTop: "--activity-clear-top",
  noHistory: "--activity-no-history",
};
const FLAG_ACTIVITY_NEW_TASK = "0x10000000";

/** Java class-name segments: letters, digits, `_` and `$`, not starting with a digit. */
const CLASS_NAME_PATTERN = /^\.?[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

/**
 * Resolve `component` to `appId/<class>`. A component naming another package is refused: this
 * tool launches the app under test, not arbitrary components.
 */
export function resolveIntentComponent(appId: string, component: string): string {
  const slash = component.indexOf("/");
  const pkg = slash === -1 ? appId : component.slice(0, slash);
  const className = slash === -1 ? component : component.slice(slash + 1);
  if (pkg !== appId) {
    throw new AndroidLaunchIntentError(
      "invalid_intent",
      `intent.component ${JSON.stringify(component)} belongs to package ${JSON.stringify(pkg)}, not ${JSON.stringify(appId)}. launchApp only starts activities of the app being launched.`,
    );
  }
  if (!CLASS_NAME_PATTERN.test(className)) {
    throw new AndroidLaunchIntentError(
      "invalid_intent",
      `intent.component class ${JSON.stringify(className)} is not a valid activity class name.`,
    );
  }
  if (!className.startsWith(".") && !className.includes(".")) {
    // A bare simple name is relative to the package, like a leading ".".
    return `${appId}/.${className}`;
  }
  return `${appId}/${className}`;
}

/** `--esa` splits on commas, so a literal comma in an element must be escaped. */
function stringArrayValue(values: string[]): string {
  return values.map((value) => value.replace(/,/g, "\\,")).join(",");
}

/** Java int is 32-bit; a long beyond 2^53 cannot be represented exactly in JSON numbers. */
function fitsJavaInteger(type: "int" | "long", value: number): boolean {
  if (!Number.isSafeInteger(value)) {
    return false;
  }
  return type === "long" || (value >= -(2 ** 31) && value <= 2 ** 31 - 1);
}

function extraArgs(extra: AndroidIntentExtra): string[] {
  if (extra.key.length === 0) {
    throw new AndroidLaunchIntentError("invalid_intent", "intent.extras keys must be non-empty.");
  }
  if (
    (extra.type === "int" || extra.type === "long") &&
    !fitsJavaInteger(extra.type, extra.value)
  ) {
    throw new AndroidLaunchIntentError(
      "invalid_intent",
      `intent extra ${JSON.stringify(extra.key)} must be an integer that fits a Java ${extra.type}.`,
    );
  }
  if (extra.type === "float" && !Number.isFinite(extra.value)) {
    throw new AndroidLaunchIntentError(
      "invalid_intent",
      `intent extra ${JSON.stringify(extra.key)} must be a finite number.`,
    );
  }
  const value = extra.type === "stringArray" ? stringArrayValue(extra.value) : String(extra.value);
  return [EXTRA_FLAGS[extra.type], shellQuote(extra.key), shellQuote(value)];
}

function flagArgs(flags: AndroidIntentFlag[] = []): string[] {
  const unique = [...new Set(flags)];
  return unique.flatMap((flag) =>
    flag === "newTask" ? ["-f", FLAG_ACTIVITY_NEW_TASK] : [FLAG_OPTIONS[flag]],
  );
}

/**
 * Build the `am start` argument string for `intent`. Every caller-supplied value is shell-quoted
 * individually; nothing is passed through as raw command text. Without a component, the intent
 * is restricted to `appId` with `-p`, so the platform resolves an activity of that app only.
 */
export function buildAmStartIntentArgs(appId: string, intent: AndroidLaunchIntent): string {
  const args: string[] = [];
  if (intent.action) {
    args.push("-a", shellQuote(intent.action));
  }
  if (intent.data) {
    args.push("-d", shellQuote(intent.data));
  }
  if (intent.mimeType) {
    args.push("-t", shellQuote(intent.mimeType));
  }
  for (const category of intent.categories ?? []) {
    args.push("-c", shellQuote(category));
  }
  for (const extra of intent.extras ?? []) {
    args.push(...extraArgs(extra));
  }
  args.push(...flagArgs(intent.flags));
  if (intent.component) {
    args.push("-n", shellQuote(resolveIntentComponent(appId, intent.component)));
  } else {
    if (!intent.action && !intent.data) {
      throw new AndroidLaunchIntentError(
        "invalid_intent",
        "intent needs a component, an action or a data URI so Android can resolve an activity.",
      );
    }
    args.push("-p", shellQuote(appId));
  }
  return args.join(" ");
}

/**
 * Map `am start` output to a typed failure, or `undefined` when it reports none. `am` often exits
 * 0 while printing the error, so the output, not the exit code, decides.
 */
export function classifyAmStartFailure(output: string): AndroidLaunchIntentError | undefined {
  const line = (pattern: RegExp) =>
    output
      .split(/\r?\n/)
      .map((candidate) => candidate.trim())
      .find((candidate) => pattern.test(candidate));
  const denial = line(/Permission Denial/i);
  if (denial) {
    return new AndroidLaunchIntentError(
      "activity_not_exported",
      `${denial} The activity is not exported (android:exported="false") or requires a permission; launch an exported activity, or use a debug build that exports it.`,
    );
  }
  const missing = line(/does not exist/i);
  if (missing) {
    return new AndroidLaunchIntentError(
      "activity_not_found",
      `${missing} Check the component name against the app's manifest.`,
    );
  }
  const unresolved = line(/unable to resolve Intent|Activity not started/i);
  if (unresolved) {
    return new AndroidLaunchIntentError(
      "intent_unresolved",
      `${unresolved} No activity of the app matches this action, data and categories.`,
    );
  }
  const error = line(/^Error/);
  return error ? new AndroidLaunchIntentError("am_start_failed", error) : undefined;
}
