import { z } from "zod/v4";
import { ActionableError } from "../../models/ActionableError";
import { shellQuote } from "../../utils/shellQuote";

/**
 * The typed Android intent shared by `sendBroadcast` (#14081) and `launchApp.intent` (#14080).
 * Every part is typed and shell-quoted when it is turned into `am` arguments; a raw command string
 * is never accepted.
 */

const key = z.string().min(1).max(256);

export const androidIntentExtraSchema = z.discriminatedUnion("type", [
  z.object({ key, type: z.literal("string"), value: z.string() }).strict(),
  z.object({ key, type: z.literal("int"), value: z.number().int() }).strict(),
  z.object({ key, type: z.literal("long"), value: z.number().int() }).strict(),
  z.object({ key, type: z.literal("float"), value: z.number().finite() }).strict(),
  z.object({ key, type: z.literal("boolean"), value: z.boolean() }).strict(),
  z.object({ key, type: z.literal("stringArray"), value: z.array(z.string()) }).strict(),
  z.object({ key, type: z.literal("uri"), value: z.string() }).strict(),
]);

export type AndroidIntentExtra = z.infer<typeof androidIntentExtraSchema>;

export const androidIntentFields = {
  component: z
    .string()
    .min(1)
    .optional()
    .describe('A class inside appId: ".Receiver", "com.app.Receiver", or "com.app/.Receiver"'),
  action: z.string().min(1).optional().describe("Intent action, e.g. com.app.DEBUG_TOGGLE"),
  data: z.string().min(1).optional().describe("Data URI"),
  mimeType: z.string().min(1).optional(),
  categories: z.array(z.string().min(1)).max(16).optional(),
  extras: z.array(androidIntentExtraSchema).max(64).optional().describe("Typed extras"),
};

export interface AndroidIntent {
  component?: string;
  action?: string;
  data?: string;
  mimeType?: string;
  categories?: string[];
  extras?: AndroidIntentExtra[];
}

const EXTRA_FLAG: Record<AndroidIntentExtra["type"], string> = {
  string: "--es",
  int: "--ei",
  long: "--el",
  float: "--ef",
  boolean: "--ez",
  stringArray: "--esa",
  uri: "--eu",
};

/** `--esa` splits on commas; an element holding one is escaped as `\,`. */
function stringArrayValue(values: readonly string[]): string {
  return values.map((value) => value.replace(/\\/g, "\\\\").replace(/,/g, "\\,")).join(",");
}

function extraArgs(extra: AndroidIntentExtra): string[] {
  const value = extra.type === "stringArray" ? stringArrayValue(extra.value) : String(extra.value);
  return [EXTRA_FLAG[extra.type], shellQuote(extra.key), shellQuote(value)];
}

/**
 * The `-n` component for `appId`, refusing one that names another package: these tools address
 * the app under test, never arbitrary components.
 */
export function resolveComponent(appId: string, component: string): string {
  const slash = component.indexOf("/");
  if (slash >= 0) {
    const pkg = component.slice(0, slash);
    const cls = component.slice(slash + 1);
    if (pkg !== appId || cls.length === 0) {
      throw new ActionableError(
        `Component "${component}" is outside ${appId}; name a class inside the app under test.`,
      );
    }
    return `${appId}/${cls}`;
  }
  return `${appId}/${component}`;
}

/** Intent arguments for `am`, every value quoted for the device shell. */
export function androidIntentArgs(appId: string, intent: AndroidIntent): string[] {
  return [
    ...(intent.action ? ["-a", shellQuote(intent.action)] : []),
    ...(intent.data ? ["-d", shellQuote(intent.data)] : []),
    ...(intent.mimeType ? ["-t", shellQuote(intent.mimeType)] : []),
    ...(intent.categories ?? []).flatMap((category) => ["-c", shellQuote(category)]),
    ...(intent.component
      ? ["-n", shellQuote(resolveComponent(appId, intent.component))]
      : ["-p", shellQuote(appId)]),
    ...(intent.extras ?? []).flatMap(extraArgs),
  ];
}
