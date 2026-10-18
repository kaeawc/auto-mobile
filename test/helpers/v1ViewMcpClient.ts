/**
 * The MCP client the suites drive our servers with (issue #4678). It is the daemon's
 * own {@link LoopbackMcpClient}: an SDK v2 `Client` that reports errors exactly as the
 * v1 SDK client did (`MCP error <code>: <wire message>`, v1 numeric timeout codes, the
 * abort signal's own reason). The v1-to-v2 change in client-side error decoration is
 * therefore factored out, so the existing message/code assertions keep pinning the
 * server's wire error envelope byte for byte.
 */
export { LoopbackMcpClient as Client } from "../../src/daemon/socketServer/loopbackMcpClient";
