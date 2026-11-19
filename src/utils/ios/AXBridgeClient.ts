import { ActionableError } from "../../models/ActionableError";
import { logger } from "../logger";
import { errorMessage } from "../describeUnknownError";
import type { IdGenerator } from "../IdGenerator";
import type { Timer } from "../SystemTimer";

/** Line-framed duplex channel to the AXBridge process (newline-delimited JSON on stdio). */
export interface AXBridgeTransport {
  send(line: string): void;
  onLine(listener: (line: string) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

export interface AXBridgeInvokeActionRequest {
  actionName: string;
  elementId?: string;
  elementDesc?: string;
}

/** Action executor only: the element is resolved elsewhere and AXBridge just locates its bridged node. */
export interface AXBridgeClient {
  invokeAction(request: AXBridgeInvokeActionRequest): Promise<void>;
  close(): void;
}

interface AXBridgeWireError {
  code: string;
  message: string;
}

interface AXBridgeWireResponse {
  id: string | number | null;
  ok: boolean;
  error?: AXBridgeWireError;
}

interface Pending {
  resolve: () => void;
  reject: (error: ActionableError) => void;
  timeout: NodeJS.Timeout;
}

export const AX_BRIDGE_DEFAULT_TIMEOUT_MS = 10_000;

function isWireResponse(value: unknown): value is AXBridgeWireResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.ok === "boolean";
}

export class TransportAXBridgeClient implements AXBridgeClient {
  private readonly pending = new Map<string, Pending>();
  private closed = false;

  constructor(
    private readonly transport: AXBridgeTransport,
    private readonly idGenerator: IdGenerator,
    private readonly timer: Pick<Timer, "setTimeout" | "clearTimeout">,
    private readonly timeoutMs: number = AX_BRIDGE_DEFAULT_TIMEOUT_MS,
  ) {
    transport.onLine((line) => this.handleLine(line));
    transport.onClose(() => this.failAll("AXBridge process exited before replying."));
  }

  invokeAction(request: AXBridgeInvokeActionRequest): Promise<void> {
    if (this.closed) {
      return Promise.reject(new ActionableError("AXBridge client is closed."));
    }
    const id = this.idGenerator.next();
    return new Promise<void>((resolve, reject) => {
      const timeout = this.timer.setTimeout(() => {
        this.pending.delete(id);
        reject(new ActionableError(`AXBridge did not reply within ${this.timeoutMs} ms.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.transport.send(JSON.stringify({ id, command: "invoke-action", ...request }));
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.failAll("AXBridge client closed.");
    this.transport.close();
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      // Non-protocol output (diagnostics) must not break pending requests.
      logger.debug(`AXBridge ignored a non-JSON line: ${errorMessage(error)}`);
      return;
    }
    if (!isWireResponse(parsed) || parsed.id === null) {
      return;
    }
    const key = String(parsed.id);
    const entry = this.pending.get(key);
    if (!entry) {
      return;
    }
    this.pending.delete(key);
    this.timer.clearTimeout(entry.timeout);
    if (parsed.ok) {
      entry.resolve();
    } else {
      const code = parsed.error?.code ?? "unknown";
      const message = parsed.error?.message ?? "AXBridge reported a failure.";
      entry.reject(new ActionableError(`AXBridge ${code}: ${message}`));
    }
  }

  private failAll(message: string): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      this.timer.clearTimeout(entry.timeout);
      entry.reject(new ActionableError(message));
    }
  }
}
