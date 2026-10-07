import { describe, expect, test } from "bun:test";
import {
  REAL_CTRL_PROXY_WEBSOCKET_OPT_IN_ENV,
  assertUnitTestRealWebSocketAllowed,
  defaultWebSocketFactory,
} from "../../../src/features/observe/DeviceServiceClient";
import { ActionableError } from "../../../src/models/ActionableError";

const URL = "ws://127.0.0.1:8765/ws";

describe("real CtrlProxy WebSocket unit-test guard (#10470)", () => {
  test("the default factory refuses a real socket under bun test", () => {
    expect(process.env.NODE_ENV).toBe("test");
    expect(() => defaultWebSocketFactory(URL)).toThrow(ActionableError);
    expect(() => defaultWebSocketFactory(URL)).toThrow(/requestTapCoordinates/);
  });

  test("the error names the URL and the opt-in", () => {
    expect(() => assertUnitTestRealWebSocketAllowed(URL, { NODE_ENV: "test" })).toThrow(
      new RegExp(`${URL}.*${REAL_CTRL_PROXY_WEBSOCKET_OPT_IN_ENV}=1`, "s"),
    );
  });

  test.each(["1", "true", " YES "])("an explicit opt-in (%p) allows the socket", (value) => {
    expect(() =>
      assertUnitTestRealWebSocketAllowed(URL, {
        NODE_ENV: "test",
        [REAL_CTRL_PROXY_WEBSOCKET_OPT_IN_ENV]: value,
      }),
    ).not.toThrow();
  });

  test.each(["", "0", "false"])("a falsy opt-in (%p) keeps the guard armed", (value) => {
    expect(() =>
      assertUnitTestRealWebSocketAllowed(URL, {
        NODE_ENV: "test",
        [REAL_CTRL_PROXY_WEBSOCKET_OPT_IN_ENV]: value,
      }),
    ).toThrow(ActionableError);
  });

  test.each([undefined, "production", "development"])(
    "outside a bun test context (NODE_ENV=%p) the guard is disarmed",
    (nodeEnv) => {
      expect(() => assertUnitTestRealWebSocketAllowed(URL, { NODE_ENV: nodeEnv })).not.toThrow();
    },
  );
});
