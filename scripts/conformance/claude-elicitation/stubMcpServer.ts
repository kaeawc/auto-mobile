import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { CLIENT_CAPABILITIES_META_KEY, inputRequired } from "@modelcontextprotocol/server";
import { PUSHED_REQUEST_ID, type StubLogLine } from "./observation";

// A minimal stdio MCP server whose one tool asks the user to pick a device, the way the real
// ambiguous-device refusal does. It takes the legacy push path or the 2026-07-28 `input_required`
// path depending on what the client offered, and logs every message for the conformance run. It
// never touches a device. Usage: bun stubMcpServer.ts <log file>.
const logPath = process.argv[2];
if (!logPath) {
  throw new Error("usage: stubMcpServer.ts <log file>");
}

const MODERN_VERSION = "2026-07-28";
const schema = {
  type: "object",
  properties: { deviceId: { type: "string", enum: ["emulator-5554", "emulator-5556"] } },
  required: ["deviceId"],
};

function log(line: StubLogLine): void {
  appendFileSync(logPath as string, `${JSON.stringify(line)}\n`);
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

let offeredModern = false;
let pendingCallId: unknown;

function onToolCall(message: Record<string, unknown>): void {
  const params = (message.params ?? {}) as Record<string, unknown>;
  const meta = (params._meta ?? {}) as Record<string, unknown>;
  const answered = params.inputResponses !== undefined;
  if (answered) {
    send({ id: message.id, result: { content: [{ type: "text", text: "answered" }] } });
    return;
  }
  if (offeredModern || meta[CLIENT_CAPABILITIES_META_KEY] !== undefined) {
    log({ note: "input_required" });
    send({
      id: message.id,
      result: inputRequired({
        requestState: "conformance",
        inputRequests: {
          device: {
            method: "elicitation/create",
            params: { mode: "form", message: "Which device?", requestedSchema: schema },
          },
        },
      }),
    });
    return;
  }
  pendingCallId = message.id;
  log({ note: "pushed" });
  send({
    id: PUSHED_REQUEST_ID,
    method: "elicitation/create",
    params: { mode: "form", message: "Which device?", requestedSchema: schema },
  });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line) as Record<string, unknown>;
  log({ in: message });
  const params = (message.params ?? {}) as Record<string, unknown>;
  if (message.method === "initialize") {
    offeredModern = params.protocolVersion === MODERN_VERSION;
    send({
      id: message.id,
      result: {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "stub", version: "1" },
      },
    });
  } else if (message.method === "tools/list") {
    send({
      id: message.id,
      result: {
        tools: [
          {
            name: "pick",
            description: "Pick a device",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });
  } else if (message.method === "tools/call") {
    onToolCall(message);
  } else if (message.method === undefined && message.id === PUSHED_REQUEST_ID) {
    send({ id: pendingCallId, result: { content: [{ type: "text", text: "answered" }] } });
  } else if (message.method === "ping") {
    send({ id: message.id, result: {} });
  }
});
