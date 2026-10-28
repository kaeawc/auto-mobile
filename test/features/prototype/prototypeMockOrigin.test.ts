import { describe, expect, test } from "bun:test";
import { bindMockValue, matchMockPath } from "../../../src/features/prototype/prototypeMockBinding";
import { mockTargetOf } from "../../../src/features/prototype/prototypeMockOrigin";

describe("mockTargetOf", () => {
  test("names the backend, path and query of a reserved-origin URL", () => {
    expect(mockTargetOf("https://shop.mock.automobile.invalid/items/3?a=1&b=two")).toEqual({
      backendId: "shop",
      path: "/items/3",
      query: { a: "1", b: "two" },
    });
    expect(mockTargetOf("http://SHOP.MOCK.AUTOMOBILE.INVALID")?.backendId).toBe("shop");
  });

  test("any host under the reserved suffix is a mock address, even with no valid backend id", () => {
    expect(mockTargetOf("https://a.b.mock.automobile.invalid/")?.backendId).toBe("a.b");
    expect(mockTargetOf("https://.mock.automobile.invalid/")?.backendId).toBe("");
  });

  test("ordinary destinations, lookalikes, other schemes and garbage are not mock addresses", () => {
    for (const url of [
      "https://example.com/",
      "https://mock.automobile.invalid.example.com/",
      "https://shopmock.automobile.invalid/",
      "https://x.mock.automobile.invalid.evil.test/",
      "ftp://shop.mock.automobile.invalid/",
      "ws://shop.mock.automobile.invalid/",
      "not a url",
    ]) {
      expect(mockTargetOf(url)).toBeUndefined();
    }
  });
});

describe("matchMockPath", () => {
  test("captures parameters and requires equal segment counts", () => {
    expect(matchMockPath("/a/:id/b/:n", "/a/7/b/x")).toEqual({ id: "7", n: "x" });
    expect(matchMockPath("/a/:id", "/a/7/extra")).toBeUndefined();
    expect(matchMockPath("/a/:id", "/b/7")).toBeUndefined();
    expect(matchMockPath("/", "/")).toEqual({});
    expect(matchMockPath("/a/:id", "/a/%E2%82%AC")).toEqual({ id: "€" });
    expect(matchMockPath("/a/:id", "/a/%E0%A4%A")).toEqual({ id: "%E0%A4%A" });
  });
});

describe("bindMockValue", () => {
  const context = {
    params: { id: "5" },
    query: { q: "hi" },
    body: { n: 2, list: [1, { x: "y" }], s: "t" },
  };

  test("an exact placeholder takes the bound value's type", () => {
    expect(bindMockValue("{body:/n}", context)).toBe(2);
    expect(bindMockValue("{body:/list/1}", context)).toEqual({ x: "y" });
    expect(bindMockValue("{params.id}", context)).toBe("5");
    expect(bindMockValue("{body:/nope}", context)).toBeNull();
    expect(bindMockValue("{query.zzz}", context)).toBeNull();
  });

  test("placeholders inside text interpolate, objects as JSON, unbound as empty", () => {
    expect(
      bindMockValue("id={params.id} n={body:/n} l={body:/list/1} z={query.zzz}.", context),
    ).toBe('id=5 n=2 l={"x":"y"} z=.');
  });

  test("only own properties bind, so inherited names are unbound", () => {
    for (const token of [
      "query.toString",
      "query.constructor",
      "query.__proto__",
      "params.hasOwnProperty",
    ]) {
      expect(bindMockValue(`{${token}}`, context)).toBeNull();
      expect(bindMockValue(`a{${token}}b`, context)).toBe("ab");
    }
  });

  test("binds recursively through arrays and objects and leaves other values alone", () => {
    expect(
      bindMockValue({ a: ["{params.id}", 1, true, null, { b: "{query.q}" }] }, context),
    ).toEqual({
      a: ["5", 1, true, null, { b: "hi" }],
    });
    expect(bindMockValue("{not a placeholder}", context)).toBe("{not a placeholder}");
    expect(bindMockValue("{body}", context)).toBe("{body}");
  });
});
