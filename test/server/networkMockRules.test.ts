import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NetworkState } from "../../src/server/NetworkState";
import { buildNetworkMockRules } from "../../src/server/networkMockRules";

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
    expect(buildNetworkMockRules(state)).toEqual([]);
  });

  test("maps every mock field onto the wire shape", function () {
    const mock = state.addMock({
      host: "api\\.example\\.com",
      path: "/v1/items",
      method: "GET",
      limit: 3,
      remaining: 3,
      statusCode: 201,
      responseHeaders: { "X-Test": "yes" },
      responseBody: '{"ok":true}',
      contentType: "application/json",
    });

    expect(buildNetworkMockRules(state)).toEqual([
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

  test("reinitializes remaining from limit so the device gets fresh counts", function () {
    const mock = state.addMock({
      host: "h",
      path: "/p",
      method: "POST",
      limit: 5,
      remaining: 1,
      statusCode: 200,
      responseHeaders: {},
      responseBody: "",
      contentType: "text/plain",
    });

    const [rule] = buildNetworkMockRules(state);
    expect(rule.mockId).toBe(mock.mockId);
    expect(rule.limit).toBe(5);
    expect(rule.remaining).toBe(5);
  });

  test("preserves a null limit and emits a null remaining", function () {
    state.addMock({
      host: "h",
      path: "/p",
      method: "GET",
      limit: null,
      remaining: null,
      statusCode: 200,
      responseHeaders: {},
      responseBody: "",
      contentType: "text/plain",
    });

    const [rule] = buildNetworkMockRules(state);
    expect(rule.limit).toBeNull();
    expect(rule.remaining).toBeNull();
  });

  test("returns one rule per registered mock", function () {
    state.addMock({
      host: "a",
      path: "/1",
      method: "GET",
      limit: 1,
      remaining: 1,
      statusCode: 200,
      responseHeaders: {},
      responseBody: "",
      contentType: "text/plain",
    });
    state.addMock({
      host: "b",
      path: "/2",
      method: "GET",
      limit: 1,
      remaining: 1,
      statusCode: 200,
      responseHeaders: {},
      responseBody: "",
      contentType: "text/plain",
    });

    expect(buildNetworkMockRules(state)).toHaveLength(2);
  });
});
