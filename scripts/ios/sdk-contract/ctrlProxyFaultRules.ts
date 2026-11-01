import { defaultIdGenerator, type IdGenerator } from "../../../src/utils/IdGenerator";
import { defaultTimer, type Timer } from "../../../src/utils/SystemTimer";
import type { NetworkFaultRuleWire } from "./faultSlice";

/**
 * Sends `set_network_fault_rules` to CtrlProxy over its own WebSocket, the command the runner
 * forwards to the tracked foreground app's SDK server. The daemon has no MCP tool that sends
 * iOS fault rules, so the harness speaks CtrlProxy's wire command directly; it is the same
 * command and route a client would use, not a stand-in for them.
 */
export interface FaultRuleDelivery {
  success: boolean;
  error?: string;
}

/** The subset of a WebSocket the delivery uses, so tests can drive it without a runner. */
export interface CommandSocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: (() => void) | null;
}

export interface FaultRuleDeliveryDeps {
  openSocket: (url: string) => CommandSocket;
  timer: Timer;
  ids: IdGenerator;
}

const RESULT_TYPE = "set_network_fault_rules_result";
const ATTEMPT_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 2_000;

/** Wraps the runtime WebSocket in the narrow interface the delivery uses. */
function openWebSocket(url: string): CommandSocket {
  const ws = new WebSocket(url);
  const socket: CommandSocket = {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  };
  ws.onopen = () => socket.onopen?.();
  ws.onmessage = (event) => socket.onmessage?.({ data: event.data });
  ws.onerror = (event) => socket.onerror?.(event);
  ws.onclose = () => socket.onclose?.();
  return socket;
}

const defaultDeps: FaultRuleDeliveryDeps = {
  openSocket: openWebSocket,
  timer: defaultTimer,
  ids: defaultIdGenerator,
};

function parseResult(data: unknown, requestId: string): FaultRuleDelivery | undefined {
  if (typeof data !== "string") {
    return undefined;
  }
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    // A frame that is not JSON cannot be this command's result; keep waiting for it.
    return undefined;
  }
  if (typeof message !== "object" || message === null) {
    return undefined;
  }
  const fields = message as Record<string, unknown>;
  if (fields.type !== RESULT_TYPE || fields.requestId !== requestId) {
    return undefined;
  }
  // CtrlProxy's SetNetworkFaultRulesResponse encodes `success` as `ok` on the wire.
  return fields.ok === true
    ? { success: true }
    : { success: false, error: "CtrlProxy reported ok: false (no SDK server answered)" };
}

/** One request on a fresh socket; resolves on the matching result, a socket error or timeout. */
export function sendFaultRulesOnce(
  url: string,
  rules: readonly NetworkFaultRuleWire[],
  deps: FaultRuleDeliveryDeps,
): Promise<FaultRuleDelivery> {
  const requestId = `contractFaultRules-${deps.ids.next()}`;
  return new Promise((resolve) => {
    let settled = false;
    const socket = deps.openSocket(url);
    const finish = (result: FaultRuleDelivery) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.close();
      resolve(result);
    };
    void deps.timer
      .sleep(ATTEMPT_TIMEOUT_MS)
      .then(() =>
        finish({ success: false, error: `no ${RESULT_TYPE} within ${ATTEMPT_TIMEOUT_MS} ms` }),
      );
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "set_network_fault_rules", requestId, rules }));
    };
    socket.onmessage = (event) => {
      const result = parseResult(event.data, requestId);
      if (result) {
        finish(result);
      }
    };
    socket.onerror = (event) =>
      finish({ success: false, error: `CtrlProxy socket error: ${String(event)}` });
    socket.onclose = () =>
      finish({ success: false, error: "CtrlProxy closed the socket before answering" });
  });
}

/**
 * Retries while CtrlProxy reports no SDK server: right after launch the app may not have
 * registered its server with the runner yet.
 */
export async function setFaultRulesThroughCtrlProxy(
  port: number,
  rules: readonly NetworkFaultRuleWire[],
  deps: FaultRuleDeliveryDeps = defaultDeps,
): Promise<FaultRuleDelivery> {
  const url = `ws://127.0.0.1:${port}/ws`;
  let last: FaultRuleDelivery = { success: false, error: "not attempted" };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    last = await sendFaultRulesOnce(url, rules, deps);
    if (last.success) {
      return last;
    }
    if (attempt < MAX_ATTEMPTS) {
      await deps.timer.sleep(RETRY_DELAY_MS);
    }
  }
  return { success: false, error: `${last.error} (after ${MAX_ATTEMPTS} attempts)` };
}
