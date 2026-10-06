import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NetworkState } from "../../src/server/NetworkState";
import {
  buildNetworkMockRules,
  describeInvalidMockPattern,
  parseMockRuleReport,
} from "../../src/server/networkMockRules";

const DEVICE = "emulator-5554";

describe("parseMockRuleReport (#10101)", function () {
  test("an absent rejectedMockIds is not a report, so nothing is claimed installed", function () {
    expect(parseMockRuleReport({})).toEqual({ status: "unconfirmed" });
    expect(parseMockRuleReport({ rejectedMockIds: null })).toEqual({ status: "unconfirmed" });
    expect(parseMockRuleReport({ rejectedMockIds: "m1" })).toEqual({ status: "unconfirmed" });
  });

  test("an empty list is a report that nothing was rejected", function () {
    expect(parseMockRuleReport({ rejectedMockIds: [] })).toEqual({
      status: "reported",
      rejected: [],
    });
  });

  test("pairs each rejected id with the device's reason", function () {
    expect(
      parseMockRuleReport({
        rejectedMockIds: ["m1", "m2"],
        rejectedReasons: { m1: "invalid regex: a", m2: "invalid regex: b" },
      }),
    ).toEqual({
      status: "reported",
      rejected: [
        { mockId: "m1", reason: "invalid regex: a" },
        { mockId: "m2", reason: "invalid regex: b" },
      ],
    });
  });

  test("a rejected id the device gave no reason for still gets listed", function () {
    expect(parseMockRuleReport({ rejectedMockIds: ["m1", 7], rejectedReasons: {} })).toEqual({
      status: "reported",
      rejected: [{ mockId: "m1", reason: "no reason reported by the device" }],
    });
  });
});

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
