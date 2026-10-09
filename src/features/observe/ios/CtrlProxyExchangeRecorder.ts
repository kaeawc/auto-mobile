/**
 * Opt-in golden capture of the host <-> iOS CtrlProxy runner WebSocket exchanges
 * (issue #5837).
 *
 * When `AUTOMOBILE_IOS_CTRLPROXY_RECORD_DIR` is set, the iOS client wraps its
 * WebSocket factory so every request it sends and every message the runner
 * answers with is written to that directory as one JSON file per exchange:
 *
 *   NNNN-<request type>.json  {"request": {...}, "response": {...}}
 *   NNNN-push-<type>.json     {"push": {...}}   (messages with no pending request)
 *
 * The files replay through `test/fakes/ReplayCtrlProxyWebSocket.ts` in unit tests.
 * See docs/design-docs/plat/ios/ctrlproxy-golden-replay.md.
 *
 * Owner policy: nothing is redacted except text typed into a password field.
 * The recorder cannot see the field it types into, so it resolves the target
 * against the latest recorded hierarchy and redacts whenever the target is a
 * password field or cannot be resolved (fail-safe).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type WebSocket from "ws";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { WebSocketFactory } from "../DeviceServiceClient";

export const IOS_CTRL_PROXY_RECORD_DIR_ENV = "AUTOMOBILE_IOS_CTRLPROXY_RECORD_DIR";

/** Replacement written in place of text typed into a password (or unresolved) field. */
export const REDACTED_PASSWORD_TEXT = "<redacted:password-field>";

const TEXT_INPUT_REQUEST_TYPES: ReadonlySet<string> = new Set([
  "request_set_text",
  "request_append_text",
]);

/** Where recorded exchanges go. The file implementation is the only production sink. */
export interface ExchangeSink {
  write(fileName: string, contents: string): void;
}

export class DirectoryExchangeSink implements ExchangeSink {
  private created = false;

  constructor(private readonly directory: string) {}

  write(fileName: string, contents: string): void {
    if (!this.created) {
      mkdirSync(this.directory, { recursive: true });
      this.created = true;
    }
    writeFileSync(path.join(this.directory, fileName), contents);
  }
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function childNodes(node: JsonObject): JsonObject[] {
  const children = node.node;
  if (Array.isArray(children)) {
    return children.filter(isObject);
  }
  return isObject(children) ? [children] : [];
}

function findNode(root: JsonObject, predicate: (node: JsonObject) => boolean): JsonObject | null {
  const stack: JsonObject[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as JsonObject;
    if (predicate(node)) {
      return node;
    }
    stack.push(...childNodes(node));
  }
  return null;
}

/** The hierarchy root carried by a runner `hierarchy_update` message, if any. */
function hierarchyRoot(message: JsonObject): JsonObject | null {
  const data = message.data;
  if (!isObject(data)) {
    return null;
  }
  return isObject(data.hierarchy) ? data.hierarchy : null;
}

function sanitizeFileToken(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

export class CtrlProxyExchangeRecorder {
  private sequence = 0;
  private readonly pending = new Map<string, JsonObject>();
  private latestHierarchy: JsonObject | null = null;

  constructor(private readonly sink: ExchangeSink) {}

  /** Record an outgoing frame. Returns nothing; the frame itself is sent unchanged. */
  onSent(data: unknown): void {
    const request = this.parse(data);
    if (!request) {
      return;
    }
    const requestId = request.requestId;
    if (typeof requestId === "string") {
      this.pending.set(requestId, this.redactRequest(request));
      return;
    }
    // Fire-and-forget frames (e.g. set_hierarchy_poll_interval) have no reply.
    this.write(String(request.type ?? "request"), { request: this.redactRequest(request) });
  }

  onReceived(data: unknown): void {
    const message = this.parse(data);
    if (!message) {
      return;
    }
    const root = hierarchyRoot(message);
    if (root) {
      this.latestHierarchy = root;
    }
    const requestId = message.requestId;
    const request = typeof requestId === "string" ? this.pending.get(requestId) : undefined;
    if (request && typeof requestId === "string") {
      this.pending.delete(requestId);
      this.write(String(request.type ?? "request"), { request, response: message });
      return;
    }
    this.write(`push-${String(message.type ?? "message")}`, { push: message });
  }

  private parse(data: unknown): JsonObject | null {
    const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString() : null;
    if (text === null) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return isObject(parsed) ? parsed : null;
    } catch (error) {
      // The runner speaks JSON only; a non-JSON frame is not an exchange to record.
      logger.debug(`[CtrlProxyExchangeRecorder] Skipping non-JSON frame: ${errorMessage(error)}`);
      return null;
    }
  }

  private redactRequest(request: JsonObject): JsonObject {
    const type = request.type;
    if (typeof type !== "string" || !TEXT_INPUT_REQUEST_TYPES.has(type)) {
      return request;
    }
    if (typeof request.text !== "string" || !this.targetsPasswordOrUnknownField(request)) {
      return request;
    }
    return { ...request, text: REDACTED_PASSWORD_TEXT };
  }

  private targetsPasswordOrUnknownField(request: JsonObject): boolean {
    if (!this.latestHierarchy) {
      return true;
    }
    const resourceId = request.resourceId;
    const target =
      typeof resourceId === "string" && resourceId.length > 0
        ? findNode(this.latestHierarchy, (node) => node.resourceId === resourceId)
        : findNode(this.latestHierarchy, (node) => node.focused === "true");
    return !target || target.password === "true";
  }

  private write(kind: string, exchange: JsonObject): void {
    this.sequence += 1;
    const fileName = `${String(this.sequence).padStart(4, "0")}-${sanitizeFileToken(kind)}.json`;
    try {
      this.sink.write(fileName, `${JSON.stringify(exchange, null, 2)}\n`);
    } catch (error) {
      logger.warn(
        `[CtrlProxyExchangeRecorder] Failed to record ${fileName}: ${errorMessage(error)}`,
        error,
      );
    }
  }
}

/** Wrap `inner` so each socket it creates reports its traffic to `recorder`. */
export function recordingWebSocketFactory(
  inner: WebSocketFactory,
  recorder: CtrlProxyExchangeRecorder,
): WebSocketFactory {
  return (url: string) => {
    const socket = inner(url);
    const send = socket.send.bind(socket) as (data: WebSocket.Data, ...args: unknown[]) => void;
    socket.send = ((data: WebSocket.Data, ...args: unknown[]) => {
      recorder.onSent(data);
      return send(data, ...args);
    }) as WebSocket["send"];
    socket.on("message", (data: WebSocket.Data) => recorder.onReceived(data));
    return socket;
  };
}

/**
 * Returns `factory` wrapped with a recorder when the record-dir env var is set,
 * otherwise `factory` unchanged.
 */
export function withCtrlProxyRecordingFromEnv(
  factory: WebSocketFactory,
  env: NodeJS.ProcessEnv = process.env,
  sinkFor: (directory: string) => ExchangeSink = (directory) =>
    new DirectoryExchangeSink(directory),
): WebSocketFactory {
  const directory = env[IOS_CTRL_PROXY_RECORD_DIR_ENV]?.trim();
  if (!directory) {
    return factory;
  }
  logger.info(`[CtrlProxyExchangeRecorder] Recording iOS CtrlProxy exchanges to ${directory}`);
  return recordingWebSocketFactory(factory, new CtrlProxyExchangeRecorder(sinkFor(directory)));
}
