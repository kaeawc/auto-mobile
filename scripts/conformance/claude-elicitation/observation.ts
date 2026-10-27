/** One JSON line the stub MCP server writes per message it sees or sends. */
export type StubLogLine =
  | { readonly in: Record<string, unknown> }
  | { readonly note: "answered" | "pushed" | "input_required"; readonly detail?: unknown };

export type ElicitationEraTaken = "legacy_push" | "modern_input_required" | "none";

export interface ElicitationObservation {
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly protocolVersion?: string;
  /** The `elicitation` entry of the capabilities declared on `initialize`; absent when none. */
  readonly declared?: Record<string, unknown>;
  /** True when `tools/call` carried the per-request client-capabilities `_meta` key. */
  readonly capabilitiesOnToolCall: boolean;
  readonly eraTaken: ElicitationEraTaken;
  /** How the client answered an `elicitation/create` push or `input_required` retry. */
  readonly answerAction?: string;
  readonly toolCalled: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Reduces the stub's message log to the facts the conformance run asserts on. */
export function observeElicitation(
  lines: readonly StubLogLine[],
  capabilitiesMetaKey: string,
): ElicitationObservation {
  let observation: ElicitationObservation = {
    capabilitiesOnToolCall: false,
    eraTaken: "none",
    toolCalled: false,
  };
  for (const line of lines) {
    if ("note" in line) {
      if (line.note === "pushed") {
        observation = { ...observation, eraTaken: "legacy_push" };
      }
      if (line.note === "input_required") {
        observation = { ...observation, eraTaken: "modern_input_required" };
      }
      continue;
    }
    const message = line.in;
    const params = record(message.params);
    if (message.method === "initialize") {
      const info = record(params?.clientInfo);
      observation = {
        ...observation,
        clientName: text(info?.name),
        clientVersion: text(info?.version),
        protocolVersion: text(params?.protocolVersion),
        declared: record(record(params?.capabilities)?.elicitation),
      };
    } else if (message.method === "tools/call") {
      const responses = record(params?.inputResponses);
      observation = responses
        ? { ...observation, answerAction: text(record(Object.values(responses)[0])?.action) }
        : {
            ...observation,
            toolCalled: true,
            capabilitiesOnToolCall: record(params?._meta)?.[capabilitiesMetaKey] !== undefined,
          };
    } else if (message.method === undefined && message.id === PUSHED_REQUEST_ID) {
      observation = { ...observation, answerAction: text(record(message.result)?.action) };
    }
  }
  return observation;
}

/** The id the stub uses for its pushed `elicitation/create` request. */
export const PUSHED_REQUEST_ID = 900;

/** Why a run does not conform; empty when it does. */
export function conformanceProblems(observation: ElicitationObservation): string[] {
  const problems: string[] = [];
  if (!observation.toolCalled) {
    problems.push("the client never called the stub tool");
  }
  if (observation.eraTaken === "none") {
    problems.push("the stub could not ask the question: the client declared no elicitation");
  } else if (observation.answerAction === undefined) {
    problems.push("the client did not answer the question");
  } else if (!["accept", "decline", "cancel"].includes(observation.answerAction)) {
    problems.push(`the client answered with an unknown action "${observation.answerAction}"`);
  }
  return problems;
}
