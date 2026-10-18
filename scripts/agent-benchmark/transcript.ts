/**
 * Audit a Claude Code `--output-format stream-json --verbose` transcript.
 *
 * The stream is one JSON object per line. The harness relies on four event kinds:
 * `system/init` (model, MCP server connection status), `assistant` (tool_use blocks),
 * `user` (tool_result blocks, `is_error`), and the final `result` (turns, cost,
 * permission denials, final text). Every other event type is ignored, so new CLI
 * event kinds never break parsing.
 */
import { MCP_TOOL_PREFIX, MCP_SERVER_NAME, shortToolName } from "./config";

const RESULT_TEXT_LIMIT = 400;

export interface ToolCallRecord {
  id: string;
  /** Full tool name as Claude saw it, e.g. `mcp__auto-mobile__observe`. */
  name: string;
  shortName: string;
  isMcp: boolean;
  /** True when the call was made by a subagent (parent_tool_use_id set). */
  isSubagent: boolean;
  /** 1-based JSONL line of the tool_use. */
  line: number;
  isError: boolean;
  /** True once the call's tool_result arrived; a call without one never finished. */
  hasResult: boolean;
  /** True when the error result matched an `ignoredFailurePatterns` entry. */
  errorIgnored: boolean;
  /** Truncated tool result text; empty until the result arrives. */
  resultText: string;
}

export interface PatternMatch {
  pattern: string;
  tool: string;
  line: number;
}

export interface TranscriptAudit {
  observedModel?: string;
  claudeCodeVersion?: string;
  /** Status of the auto-mobile MCP server from system/init, e.g. `connected`/`failed`. */
  mcpServerStatus?: string;
  toolCalls: ToolCallRecord[];
  toolCounts: Record<string, number>;
  totalToolCalls: number;
  mcpToolCalls: number;
  /** Tool results with `is_error`, excluding ones matched by `ignoredFailurePatterns`. */
  toolErrors: number;
  patternMatches: PatternMatch[];
  permissionDenials: string[];
  parseErrors: string[];
  result?: {
    subtype: string;
    isError: boolean;
    numTurns?: number;
    costUsd?: number;
    durationMs?: number;
    finalText: string;
    terminalReason?: string;
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface AuditOptions {
  failurePatterns: string[];
  ignoredFailurePatterns: string[];
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Protocol identifiers (event and block types, tool names and ids) are exact strings: blank
 * ones carry nothing and padded ones are not the identifier they look like, so neither is
 * trimmed into a match.
 */
function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value === value.trim();
}
/**
 * The content blocks of an assistant or user event. Plain-text content (a string) has no
 * blocks; any other shape could hide tool calls or results, so it is a parse error.
 */
function contentBlocks(event: JsonRecord, line: number, state: AuditState): JsonRecord[] {
  const message = event.message;
  const content = isRecord(message) ? message.content : undefined;
  if (typeof content === "string") {
    return [];
  }
  if (!Array.isArray(content)) {
    state.audit.parseErrors.push(`line ${line}: ${String(event.type)} event has malformed content`);
    return [];
  }
  if (!content.every(isRecord)) {
    state.audit.parseErrors.push(
      `line ${line}: ${String(event.type)} event has a non-object block`,
    );
  }
  const blocks = content.filter(isRecord);
  if (blocks.some((block) => !isIdentifier(block.type))) {
    // Unknown block kinds are skipped, but a block with no kind, or a padded one that would
    // be skipped as unknown, could be hiding a tool call.
    state.audit.parseErrors.push(
      `line ${line}: ${String(event.type)} event has a block without an exact type`,
    );
  }
  return blocks;
}

/**
 * A tool_result content block: an object whose `text`, when present, is a string. Other
 * block types (an image) carry no text and are fine; a bare string or a non-string `text`
 * would be dropped and could hide failure evidence.
 */
function isContentBlock(block: unknown): boolean {
  return (
    isRecord(block) &&
    isIdentifier(block.type) &&
    // A text block must carry its text; other block types (an image) need none.
    (block.type === "text"
      ? typeof block.text === "string"
      : block.text === undefined || typeof block.text === "string")
  );
}

/** tool_result content is either a string or an array of `{type:"text", text}` blocks. */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(isRecord)
    .map((block) => asString(block.text) ?? "")
    .filter((text) => text.length > 0)
    .join("\n");
}

function truncate(text: string): string {
  return text.length > RESULT_TEXT_LIMIT ? `${text.slice(0, RESULT_TEXT_LIMIT)}…` : text;
}

const USAGE_KEYS = [
  "input_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "output_tokens",
];
const REQUIRED_USAGE_KEYS = ["input_tokens", "output_tokens"];
const INPUT_TOKEN_KEYS = USAGE_KEYS.slice(0, 3);

/**
 * Every count the transcript reports (turns, token counters, and their totals) must be a
 * non-negative safe integer: a fraction is not a count, and past 2^53 a JSON number has
 * already lost precision, so result.json and the baseline would record a wrong value.
 */
function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Usage components, and the input total they sum to, must be counts (see isCount). */
function usageErrors(usage: unknown, success: boolean): string[] {
  if (usage === undefined) {
    // A successful result always reports usage; without it the token metrics go missing.
    return success ? ["result event has no usage"] : [];
  }
  if (!isRecord(usage)) {
    return ["result event has a malformed usage"];
  }
  // Absent counters would read as zero and understate a successful run's tokens.
  const missing = success
    ? REQUIRED_USAGE_KEYS.filter((key) => usage[key] === undefined).map(
        (key) => `result event has no usage.${key}`,
      )
    : [];
  const invalid = USAGE_KEYS.filter((key) => usage[key] !== undefined && !isCount(usage[key])).map(
    (key) => `result event has an invalid usage.${key}`,
  );
  // Safe components can still sum past 2^53, which would store an imprecise total.
  const totals =
    invalid.length === 0 && !isCount(sumTokens(usage, INPUT_TOKEN_KEYS))
      ? ["result event has an imprecise input token total"]
      : [];
  return [...missing, ...invalid, ...totals];
}

function sumTokens(usage: unknown, keys: string[]): number | undefined {
  if (!isRecord(usage)) {
    return undefined;
  }
  return keys.reduce((total, key) => total + (asNumber(usage[key]) ?? 0), 0);
}

interface AuditState {
  audit: TranscriptAudit;
  callsById: Map<string, ToolCallRecord>;
  fullResultText: Map<string, string>;
}

/** A fingerprint string; blank identifies nothing, so it stays unknown and cannot be baselined. */
function identity(value: unknown): string | undefined {
  return asString(value)?.trim() || undefined;
}

function handleInit(event: JsonRecord, state: AuditState): void {
  if (state.audit.mcpServerStatus !== undefined) {
    // A second init would replace the first one's MCP status (a failure, say) and hide it.
    state.audit.parseErrors.push("duplicate system/init event");
    return;
  }
  state.audit.observedModel ??= identity(event.model);
  state.audit.claudeCodeVersion ??= identity(event.claude_code_version);
  const servers = Array.isArray(event.mcp_servers) ? event.mcp_servers.filter(isRecord) : [];
  const ours = servers.filter((server) => server.name === MCP_SERVER_NAME);
  if (ours.length > 1) {
    // Two entries for one server can disagree (connected, then failed); trust neither.
    state.audit.parseErrors.push(`init lists ${MCP_SERVER_NAME} ${ours.length} times`);
  }
  state.audit.mcpServerStatus = asString(ours[0]?.status) ?? "missing";
}

function handleAssistant(event: JsonRecord, line: number, state: AuditState): void {
  const message = event.message;
  if (isRecord(message)) {
    state.audit.observedModel ??= identity(message.model);
  }
  const parent = event.parent_tool_use_id;
  const isSubagent = parent !== null && parent !== undefined;
  if (isSubagent && !isIdentifier(parent)) {
    // Only null/absent (top level) or an exact id (subagent) is meaningful; anything else,
    // padded ids included, would silently drop the call from the top-level sequence.
    state.audit.parseErrors.push(`line ${line}: invalid parent_tool_use_id`);
  }
  for (const block of contentBlocks(event, line, state)) {
    if (block.type === "tool_result") {
      // Results come from the user side; one here would be skipped and its outcome lost.
      state.audit.parseErrors.push(`line ${line}: tool_result in an assistant event`);
      continue;
    }
    if (block.type !== "tool_use") {
      continue;
    }
    const rawName = asString(block.name) ?? "";
    const name = rawName.trim() || "unknown";
    if (name === "unknown") {
      // A nameless call would hide which tool ran from the counts and sequence.
      state.audit.parseErrors.push(`line ${line}: tool_use without a name`);
    } else if (!isIdentifier(rawName)) {
      // A padded name is not the registered tool, so it is not canonicalized into one.
      state.audit.parseErrors.push(`line ${line}: tool_use name has surrounding whitespace`);
    }
    // Ids stay verbatim: results look them up exactly, so a padded id must not match a clean one.
    const rawId = asString(block.id) ?? "";
    const id = rawId.trim() === "" ? undefined : rawId;
    if (!id) {
      // A missing or blank id would let a result with a blank tool_use_id complete it.
      state.audit.parseErrors.push(`line ${line}: tool_use without an id`);
    } else if (!isIdentifier(id)) {
      state.audit.parseErrors.push(`line ${line}: tool_use id has surrounding whitespace`);
    }
    if (!isRecord(block.input)) {
      // Tool input is always an object; a missing or scalar one marks a damaged stream.
      state.audit.parseErrors.push(`line ${line}: tool_use without an object input`);
    }
    const record: ToolCallRecord = {
      id: id || `line-${line}`,
      name,
      shortName: shortToolName(name),
      isMcp: name.startsWith(MCP_TOOL_PREFIX),
      isSubagent,
      line,
      isError: false,
      hasResult: false,
      errorIgnored: false,
      resultText: "",
    };
    state.audit.toolCalls.push(record);
    if (state.callsById.has(record.id)) {
      // A reused id would route the next result to the wrong call and hide the first one.
      state.audit.parseErrors.push(`duplicate tool_use id ${record.id}`);
      continue;
    }
    state.callsById.set(record.id, record);
  }
}

function handleUser(event: JsonRecord, line: number, state: AuditState): void {
  for (const block of contentBlocks(event, line, state)) {
    if (block.type === "tool_use") {
      // Calls come from the assistant; one here would be skipped and missing from the counts.
      state.audit.parseErrors.push(`line ${line}: tool_use in a user event`);
      continue;
    }
    if (block.type !== "tool_result") {
      continue;
    }
    const id = asString(block.tool_use_id) ?? "";
    const record = state.callsById.get(id);
    if (!record) {
      // A result for a call the stream never showed means the transcript is incomplete, and
      // its outcome (an error, say) would otherwise go uncounted.
      state.audit.parseErrors.push(`tool_result for unknown tool_use_id ${id || "(missing)"}`);
      continue;
    }
    if (record.hasResult) {
      // A second result would overwrite the first (an error, say) and hide it.
      state.audit.parseErrors.push(`duplicate tool_result for tool_use_id ${id}`);
      continue;
    }
    if (block.content === undefined) {
      // A missing body would count as a completed, successful call with empty text.
      state.audit.parseErrors.push(`tool_result for ${id} has no content`);
    } else if (
      typeof block.content !== "string" &&
      !(Array.isArray(block.content) && block.content.every(isContentBlock))
    ) {
      // An unreadable container would read as empty text and hide failure evidence.
      state.audit.parseErrors.push(`tool_result for ${id} has malformed content`);
    }
    const text = toolResultText(block.content);
    if (block.is_error !== undefined && typeof block.is_error !== "boolean") {
      // A non-boolean flag ("true") cannot be trusted either way, so the transcript fails.
      state.audit.parseErrors.push(`tool_result for ${id} has a non-boolean is_error`);
    }
    record.isError = block.is_error === true;
    record.resultText = truncate(text);
    record.hasResult = true;
    state.fullResultText.set(record.id, text);
  }
}

function handleResult(event: JsonRecord, state: AuditState): void {
  if (state.audit.result) {
    // A second terminal result would replace the first (an error, its cost) and hide it.
    state.audit.parseErrors.push("duplicate result event");
    return;
  }
  if (typeof event.result !== "string") {
    // The final answer is required text; a missing or other-shaped one would read as empty.
    state.audit.parseErrors.push("result event has a missing or non-string result");
  }
  if (typeof event.is_error !== "boolean") {
    // The flag is required on every terminal result; a missing or non-boolean one ("true")
    // cannot be read as success.
    state.audit.parseErrors.push("result event has a missing or non-boolean is_error");
  }
  // Terminal metrics land in baseline.yml, so they must fit the baseline schema's domains.
  const turns = event.num_turns;
  if (turns === undefined && event.subtype === "success") {
    // A successful result always reports its turn count; without it the metric goes missing.
    state.audit.parseErrors.push("result event has no num_turns");
  } else if (turns !== undefined && !isCount(turns)) {
    state.audit.parseErrors.push("result event has an invalid num_turns");
  }
  const cost = event.total_cost_usd;
  if (cost === undefined && event.subtype === "success") {
    // A successful result always reports its cost; without it the metric goes missing.
    state.audit.parseErrors.push("result event has no total_cost_usd");
  } else if (cost !== undefined && !(asNumber(cost) !== undefined && (cost as number) >= 0)) {
    state.audit.parseErrors.push("result event has an invalid total_cost_usd");
  }
  const usage = event.usage;
  state.audit.parseErrors.push(...usageErrors(usage, event.subtype === "success"));
  state.audit.result = {
    subtype: asString(event.subtype) ?? "unknown",
    isError: event.is_error === true,
    numTurns: asNumber(event.num_turns),
    costUsd: asNumber(event.total_cost_usd),
    durationMs: asNumber(event.duration_ms),
    finalText: asString(event.result) ?? "",
    terminalReason: asString(event.terminal_reason),
    inputTokens: sumTokens(usage, INPUT_TOKEN_KEYS),
    outputTokens: sumTokens(usage, ["output_tokens"]),
  };
  if (event.permission_denials === undefined && event.subtype === "success") {
    // A successful result always lists its denials; a missing list cannot be read as "none".
    state.audit.parseErrors.push("result event has no permission_denials");
  } else if (event.permission_denials !== undefined && !Array.isArray(event.permission_denials)) {
    // A malformed container could hide a denial, so it is not read as "none".
    state.audit.parseErrors.push("result event has a non-array permission_denials");
  }
  const denials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
  state.audit.permissionDenials = denials.map((denial) =>
    isRecord(denial) ? (asString(denial.tool_name) ?? JSON.stringify(denial)) : String(denial),
  );
}

function handleEvent(event: JsonRecord, line: number, state: AuditState): void {
  if (!isIdentifier(event.type)) {
    // Unknown event kinds are skipped for forward compatibility, but an event with no kind, or
    // a padded one that would be skipped as unknown, could be hiding tool calls.
    state.audit.parseErrors.push(`line ${line}: event without an exact type`);
    return;
  }
  const activity = event.type === "assistant" || event.type === "user" || event.type === "result";
  if (activity && state.audit.mcpServerStatus === undefined) {
    // Activity before system/init would set the model and calls before the run's real
    // initialization, which could then no longer correct them.
    state.audit.parseErrors.push(`line ${line}: ${String(event.type)} event before system/init`);
    return;
  }
  switch (event.type) {
    case "system":
      if (event.subtype === "init") {
        handleInit(event, state);
      }
      return;
    case "assistant":
      handleAssistant(event, line, state);
      return;
    case "user":
      handleUser(event, line, state);
      return;
    case "result":
      handleResult(event, state);
      return;
    default:
      return;
  }
}

function findPatternMatches(state: AuditState, options: AuditOptions): PatternMatch[] {
  const ignored = (text: string) =>
    options.ignoredFailurePatterns.some((pattern) => text.includes(pattern));
  return state.audit.toolCalls.flatMap((call) => {
    const text = state.fullResultText.get(call.id) ?? "";
    if (ignored(text)) {
      call.errorIgnored = call.isError;
      return [];
    }
    return options.failurePatterns
      .filter((pattern) => text.includes(pattern))
      .map((pattern) => ({ pattern, tool: call.shortName, line: call.line }));
  });
}

export function auditTranscript(jsonl: string, options: AuditOptions): TranscriptAudit {
  const state: AuditState = {
    audit: {
      toolCalls: [],
      toolCounts: {},
      totalToolCalls: 0,
      mcpToolCalls: 0,
      toolErrors: 0,
      patternMatches: [],
      permissionDenials: [],
      parseErrors: [],
    },
    callsById: new Map(),
    fullResultText: new Map(),
  };
  jsonl.split("\n").forEach((rawLine, index) => {
    const text = rawLine.trim();
    if (text.length === 0) {
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch (error) {
      // A truncated final line (killed process) is reported as a parse error, not thrown.
      state.audit.parseErrors.push(`line ${index + 1}: ${String(error)}`);
      return;
    }
    if (!isRecord(event)) {
      // stream-json emits only objects; a scalar, array, or null line means a damaged stream.
      state.audit.parseErrors.push(`line ${index + 1}: not a JSON object`);
      return;
    }
    if (state.audit.result && event.type !== "result") {
      // The terminal result closes the run: its turns, cost, and answer predate anything
      // after it, so later events cannot count toward this run.
      state.audit.parseErrors.push(
        `line ${index + 1}: ${String(event.type)} event after the result`,
      );
      return;
    }
    handleEvent(event, index + 1, state);
  });
  const { audit } = state;
  audit.totalToolCalls = audit.toolCalls.length;
  audit.mcpToolCalls = audit.toolCalls.filter((call) => call.isMcp).length;
  audit.patternMatches = findPatternMatches(state, options);
  audit.toolErrors = audit.toolCalls.filter((call) => call.isError && !call.errorIgnored).length;
  audit.toolCounts = Object.fromEntries(
    [...new Set(audit.toolCalls.map((call) => call.shortName))].map((name) => [
      name,
      audit.toolCalls.filter((call) => call.shortName === name).length,
    ]),
  );
  return audit;
}
