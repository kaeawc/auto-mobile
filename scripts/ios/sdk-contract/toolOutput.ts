import {
  decodeSdkEventBatches,
  type SdkEventBatchWire,
} from "../../../src/features/observe/ios/decodeSdkEventBatches";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

/** A CLI tool result is either the structured object or an MCP `content[]` text wrapper. */
export function parseToolOutput(stdout: string): JsonRecord {
  const parsed = asRecord(JSON.parse(stdout));
  if (!parsed) {
    throw new Error("tool output is not a JSON object");
  }
  const content = parsed.content;
  if (Array.isArray(content)) {
    const text = content.map(asRecord).find((item) => item?.type === "text")?.text;
    if (typeof text === "string") {
      const inner = asRecord(JSON.parse(text));
      if (inner) {
        return inner;
      }
    }
  }
  return parsed;
}

export interface DeviceAcquisition {
  sessionUuid: string;
  ctrlProxyPort: number;
}

/** Reads the session and CtrlProxy port from a `getApple` result. */
export function readAcquisition(result: JsonRecord): DeviceAcquisition {
  const session = asRecord(asRecord(result.runtime)?.session);
  const sessionUuid = session?.sessionUuid ?? result.sessionUuid;
  const port = asRecord(result.deviceIdentity)?.iosServicePort;
  if (typeof sessionUuid !== "string" || sessionUuid.length === 0) {
    throw new Error("getApple did not return a session UUID");
  }
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("getApple did not report the CtrlProxy port");
  }
  return { sessionUuid, ctrlProxyPort: port };
}

/** The first text content of an MCP `resources/read` result, parsed as JSON. */
export function parseResourceJson(result: unknown): JsonRecord {
  const contents = asRecord(result)?.contents;
  const text = Array.isArray(contents) ? asRecord(contents[0])?.text : undefined;
  if (typeof text !== "string") {
    throw new Error("resource result has no text content");
  }
  const parsed = asRecord(JSON.parse(text));
  if (!parsed) {
    throw new Error("resource text is not a JSON object");
  }
  return parsed;
}

/** Maps SDK request id to database id for the traffic summaries that carry one. */
export function trafficIdsByRequestId(traffic: JsonRecord): Map<string, number> {
  const events = Array.isArray(traffic.events) ? traffic.events : [];
  const ids = new Map<string, number>();
  for (const event of events.map(asRecord)) {
    if (typeof event?.requestId === "string" && typeof event.id === "number") {
      ids.set(event.requestId, event.id);
    }
  }
  return ids;
}

/** Request ids of the network events in a CtrlProxy `GET /sdk-events` body. */
export function queuedRequestIds(body: string, now: () => number): Set<string> {
  const parsed: unknown = JSON.parse(body);
  const batches = (Array.isArray(parsed) ? parsed : []).filter(
    (batch): batch is SdkEventBatchWire => asRecord(batch) !== undefined,
  );
  const ids = decodeSdkEventBatches(batches, now)
    .events.filter((event) => event.eventType === "network_request")
    .map((event) => event.payload.requestId)
    .filter((id): id is string => typeof id === "string");
  return new Set(ids);
}
