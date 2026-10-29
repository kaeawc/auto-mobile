import { expect, test } from "bun:test";
import {
  parseResourceJson,
  parseToolOutput,
  queuedRequestIds,
  readAcquisition,
  trafficIdsByRequestId,
} from "../../../scripts/ios/sdk-contract/toolOutput";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

test("unwraps MCP text content and passes structured results through", () => {
  const inner = { sessionUuid: "s-1" };
  const wrapped = { content: [{ type: "text", text: JSON.stringify(inner) }] };
  expect(parseToolOutput(JSON.stringify(wrapped))).toEqual(inner);
  expect(parseToolOutput(JSON.stringify(inner))).toEqual(inner);
  expect(() => parseToolOutput("[]")).toThrow("not a JSON object");
});

test("reads the session and CtrlProxy port from either getApple shape", () => {
  const port = { deviceIdentity: { iosServicePort: 8770 } };
  expect(readAcquisition({ ...port, runtime: { session: { sessionUuid: "s-1" } } })).toEqual({
    sessionUuid: "s-1",
    ctrlProxyPort: 8770,
  });
  expect(readAcquisition({ ...port, sessionUuid: "s-2" }).sessionUuid).toBe("s-2");
  expect(() => readAcquisition({ sessionUuid: "s-3" })).toThrow("CtrlProxy port");
  expect(() => readAcquisition(port)).toThrow("session UUID");
});

test("parses resource text and indexes traffic by SDK request id", () => {
  const traffic = {
    events: [
      { id: 4, requestId: "r-1" },
      { id: 5, requestId: null },
    ],
    count: 2,
  };
  const parsed = parseResourceJson({ contents: [{ text: JSON.stringify(traffic) }] });
  expect([...trafficIdsByRequestId(parsed)]).toEqual([["r-1", 4]]);
  expect(() => parseResourceJson({ contents: [] })).toThrow("no text content");
});

test("finds network request ids still queued in CtrlProxy", () => {
  const batch = {
    bundleId: "app",
    events: [
      { eventType: "network_request", payload: encode({ requestId: "r-1", timestamp: 1 }) },
      { eventType: "log", payload: encode({ requestId: "not-network", timestamp: 1 }) },
    ],
  };
  expect([...queuedRequestIds(JSON.stringify([batch]), () => 0)]).toEqual(["r-1"]);
  expect(queuedRequestIds("[]", () => 0).size).toBe(0);
});
