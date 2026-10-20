import {
  type JSONRPCMessage,
  parseJSONRPCMessage,
  type Transport,
  type TransportSendOptions,
} from "@modelcontextprotocol/server";

function acrossJsonBoundary(message: JSONRPCMessage): JSONRPCMessage {
  return parseJSONRPCMessage(JSON.parse(JSON.stringify(message)));
}

/**
 * A transport wrapper that sends a JSON copy of every message (stringify, parse, schema-parse:
 * what the streamable HTTP transports do on either end), entered through `enter` (#11820). An
 * in-process MCP pair wrapped in it delivers exactly the bytes the HTTP hop would have.
 */
export class JsonBoundaryTransport implements Transport {
  constructor(
    private readonly inner: Transport,
    private readonly enter: <T>(fn: () => T) => T,
  ) {}

  get onclose(): Transport["onclose"] {
    return this.inner.onclose;
  }
  set onclose(handler: Transport["onclose"]) {
    this.inner.onclose = handler;
  }
  get onerror(): Transport["onerror"] {
    return this.inner.onerror;
  }
  set onerror(handler: Transport["onerror"]) {
    this.inner.onerror = handler;
  }
  get onmessage(): Transport["onmessage"] {
    return this.inner.onmessage;
  }
  set onmessage(handler: Transport["onmessage"]) {
    this.inner.onmessage = handler;
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const copy = acrossJsonBoundary(message);
    return this.enter(() => this.inner.send(copy, options));
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
