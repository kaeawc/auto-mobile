import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NetworkState } from "../../src/server/NetworkState";
import {
  buildNetworkMockRules,
  describeInvalidMockPattern,
} from "../../src/server/networkMockRules";

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

describe("describeInvalidMockPattern", function () {
  test("accepts ordinary patterns and valid quantifiers", function () {
    for (const pattern of [
      "api\\.example\\.com",
      ".*",
      "/users/\\d{3}/profile",
      "/a{2,}/b{1,4}",
      "/users/\\{id\\}",
      "/users/[{}]+",
      "\\p{L}+",
      "\\Q{id}\\E",
    ]) {
      expect(describeInvalidMockPattern(pattern)).toBeNull();
    }
  });

  test("accepts leading inline flags that JavaScript cannot compile", function () {
    for (const pattern of ["(?i)api\\.example\\.com", "(?is)a.b", "(?i)(?-s)x", "(?x) a {b "]) {
      expect(describeInvalidMockPattern(pattern)).toBeNull();
    }
  });

  test("rejects an unescaped brace that is not a quantifier and names its index", function () {
    expect(describeInvalidMockPattern("/users/{id}/profile")).toContain("unescaped '{' at index 7");
    expect(describeInvalidMockPattern("(?i)/users/{id}")).toContain("unescaped '{' at index 11");
    expect(describeInvalidMockPattern("a{,5}")).toContain("unescaped '{' at index 1");
    expect(describeInvalidMockPattern("a{2")).toContain("unescaped '{' at index 1");
  });

  test("still reports what JavaScript itself rejects", function () {
    expect(describeInvalidMockPattern("[invalid")).not.toBeNull();
    expect(describeInvalidMockPattern("(?)x")).not.toBeNull();
  });
});
