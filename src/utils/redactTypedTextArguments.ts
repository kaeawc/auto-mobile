import * as yaml from "js-yaml";
import { logger } from "./logger";
import { errorMessage } from "./describeUnknownError";
import { decodePlanYamlContent, PLAN_YAML_LOAD_OPTIONS } from "./plan/planYaml";

/**
 * Generic request and argument logs run before a tool knows whether the target field is a
 * password field, so they never carry typed user text: each typed string is replaced with
 * this placeholder. Functional records (plan and test recording, navigation edges) keep the
 * real text because they replay it.
 */
export function typedTextPlaceholder(text: string): string {
  return `<text, ${Array.from(text).length} characters>`;
}

type Redactor = (args: Record<string, unknown>) => Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactStringField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  return typeof value === "string" ? { ...record, [key]: typedTextPlaceholder(value) } : record;
}

/** Map an array, or an index-keyed object, without changing its shape. */
function mapEntries(value: unknown, map: (entry: unknown) => unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(map);
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, map(entry)]));
  }
  return value;
}

const redactSendKeys: Redactor = (args) => ({
  ...args,
  commands: mapEntries(args.commands, (command) =>
    isRecord(command) ? redactStringField(command, "text") : command,
  ),
});

const redactInputText: Redactor = (args) =>
  redactStringField(redactStringField(args, "text"), "value");

const redactClipboard: Redactor = (args) => redactStringField(args, "text");

const redactSetUIState: Redactor = (args) => ({
  ...args,
  fields: mapEntries(args.fields, (field) =>
    isRecord(field) ? redactStringField(field, "value") : field,
  ),
});

/** Redact typed text in one plan step (`tool`/`command` plus inline or `params` arguments). */
export function redactPlanStepTypedText(step: unknown): unknown {
  if (!isRecord(step)) {
    return step;
  }
  const toolName = typeof step.tool === "string" ? step.tool : step.command;
  if (typeof toolName !== "string") {
    return step;
  }
  const inline = redactTypedTextArguments(toolName, step);
  return isRecord(inline) && isRecord(inline.params)
    ? { ...inline, params: redactTypedTextArguments(toolName, inline.params) }
    : inline;
}

/**
 * Redact typed text inside a YAML plan. A plan that does not parse cannot be shown to be free
 * of typed text, so it is replaced whole.
 */
export function redactPlanYamlTypedText(planContent: string): string {
  let parsed: unknown;
  try {
    parsed = yaml.load(decodePlanYamlContent(planContent), PLAN_YAML_LOAD_OPTIONS);
  } catch (error) {
    // The plan is only being prepared for a log line; the executor reports the parse error itself.
    logger.debug(`[redactTypedTextArguments] plan YAML did not parse: ${errorMessage(error)}`);
    return `<plan, ${Array.from(planContent).length} characters>`;
  }
  const redacted = redactPlanObjectTypedText(parsed);
  return redacted === parsed ? planContent : yaml.dump(redacted, { lineWidth: -1 });
}

/** Redact typed text in a parsed plan (`{ steps: [...] }`). Returns the input when unchanged. */
export function redactPlanObjectTypedText(plan: unknown): unknown {
  if (!isRecord(plan) || !Array.isArray(plan.steps)) {
    return plan;
  }
  const steps = plan.steps.map(redactPlanStepTypedText);
  const changed = JSON.stringify(steps) !== JSON.stringify(plan.steps);
  return changed ? { ...plan, steps } : plan;
}

const redactExecutePlan: Redactor = (args) =>
  typeof args.planContent === "string"
    ? { ...args, planContent: redactPlanYamlTypedText(args.planContent) }
    : args;

const REDACTORS: ReadonlyMap<string, Redactor> = new Map([
  ["sendKeys", redactSendKeys],
  ["inputText", redactInputText],
  ["clipboard", redactClipboard],
  ["setUIState", redactSetUIState],
  ["executePlan", redactExecutePlan],
]);

/**
 * Return a copy of a tool call's arguments with typed user text replaced by
 * `<text, N characters>`. Every other field is kept as is. Non-object arguments and tools that
 * carry no typed text are returned unchanged. For generic log and diagnostic sinks only — never
 * pass the result to the tool.
 */
export function redactTypedTextArguments(toolName: string | undefined, args: unknown): unknown {
  const redactor = toolName === undefined ? undefined : REDACTORS.get(toolName);
  return redactor && isRecord(args) ? redactor(args) : args;
}
