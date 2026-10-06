import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NetworkState } from "../../src/server/NetworkState";
import { buildNetworkMockRules } from "../../src/server/networkMockRules";

const DEVICE = "emulator-5554";

describe("buildNetworkMockRules", function () {
  let state: NetworkState;

  beforeEach(function () {
    NetworkState.resetInstance();
    state = NetworkState.getInstance();
  });

  afterEach(function () {
    NetworkState.resetInstance();
  });

  test("returns an empty array when no mocks are registered", function () {
    expect(buildNetworkMockRules(state, DEVICE)).toEqual([]);
  });

  test("maps every mock field onto the wire shape", function () {
    const mock = state.addMock(DEVICE, {
      host: "api\\.example\\.com",
      path: "/v1/items",
      method: "GET",
      limit: 3,
      statusCode: 201,
      responseHeaders: { "X-Test": "yes" },
      responseBody: '{"ok":true}',
      contentType: "application/json",
    });

    expect(buildNetworkMockRules(state, DEVICE)).toEqual([
      {
        mockId: mock.mockId,
        host: "api\\.example\\.com",
        path: "/v1/items",
        method: "GET",
        limit: 3,
        remaining: 3,
        statusCode: 201,
        responseHeaders: { "X-Test": "yes" },
        responseBody: '{"ok":true}',
        contentType: "application/json",
      },
    ]);
  });

  test("sends the limit as the install-time remaining count", function () {
    const mock = state.addMock(DEVICE, {
      host: "h",
      path: "/p",
      method: "POST",
      limit: 5,
      statusCode: 200,
      responseHeaders: {},
      responseBody: "",
      contentType: "text/plain",
    });

    const [rule] = buildNetworkMockRules(state, DEVICE);
    expect(rule.mockId).toBe(mock.mockId);
    expect(rule.limit).toBe(5);
    expect(rule.remaining).toBe(5);
  });

  test("preserves a null limit and emits a null remaining", function () {
    state.addMock(DEVICE, {
      host: "h",
      path: "/p",
      method: "GET",
      limit: null,
      statusCode: 200,
      responseHeaders: {},
      responseBody: "",
      contentType: "text/plain",
    });

    const [rule] = buildNetworkMockRules(state, DEVICE);
    expect(rule.limit).toBeNull();
    expect(rule.remaining).toBeNull();
  });

  test("only returns the rules registered for the requested device", function () {
    const own = state.addMock(DEVICE, {
      host: "a",
      path: "/1",
      method: "GET",
      limit: null,
      statusCode: 200,
      responseHeaders: {},
      responseBody: "",
      contentType: "text/plain",
    });
    state.addMock("emulator-5556", {
      host: "b",
      path: "/2",
      method: "GET",
      limit: null,
      statusCode: 200,
      responseHeaders: {},
      responseBody: "",
      contentType: "text/plain",
    });

    expect(buildNetworkMockRules(state, DEVICE).map((r) => r.mockId)).toEqual([own.mockId]);
    expect(buildNetworkMockRules(state, "emulator-5556")).toHaveLength(1);
    expect(buildNetworkMockRules(state, "emulator-5558")).toEqual([]);
  });

  test("returns one rule per registered mock", function () {
    state.addMock(DEVICE, {
      host: "a",
      path: "/1",
      method: "GET",
      limit: 1,
      statusCode: 200,
      responseHeaders: {},
      responseBody: "",
      contentType: "text/plain",
    });
    state.addMock(DEVICE, {
      host: "b",
      path: "/2",
      method: "GET",
      limit: 1,
      statusCode: 200,
      responseHeaders: {},
      responseBody: "",
      contentType: "text/plain",
    });

    expect(buildNetworkMockRules(state, DEVICE)).toHaveLength(2);
  });
});
