import { expect, test } from "bun:test";
import {
  parseResourceJson,
  parseToolOutput,
  queuedRecordKeys,
  readAcquisition,
  trafficIdsByKey,
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

test("parses resource text and indexes traffic by request id, else by method and URL", () => {
  const traffic = {
    events: [
      { id: 4, requestId: "r-1", url: "http://h/a", method: "GET" },
      { id: 5, requestId: null, url: "http://h/b", method: "GET" },
      { id: 6, requestId: null },
    ],
    count: 3,
  };
  const parsed = parseResourceJson({ contents: [{ text: JSON.stringify(traffic) }] });
  expect([...trafficIdsByKey(parsed)]).toEqual([
    ["r-1", 4],
    ["url:GET http://h/b", 5],
  ]);
  expect(() => parseResourceJson({ contents: [] })).toThrow("no text content");
});

test("finds network record keys still queued in CtrlProxy", () => {
  const batch = {
    bundleId: "app",
    events: [
      { eventType: "network_request", payload: encode({ requestId: "r-1", timestamp: 1 }) },
      { eventType: "log", payload: encode({ requestId: "not-network", timestamp: 1 }) },
    ],
  };
  expect([...queuedRecordKeys(JSON.stringify([batch]), () => 0)]).toEqual(["r-1"]);
  expect(queuedRecordKeys("[]", () => 0).size).toBe(0);
});
