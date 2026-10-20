import { expect, test } from "bun:test";
import { parseBundleJson } from "../../../../src/features/prototype/bundle/bundleManifest";
import { preflightBundleSecrets } from "../../../../src/features/prototype/bundle";
import { detectImageMimeType } from "../../../../src/utils/screenshot/imageHeaderDimensions";

test("WebP signatures compare exact bytes, including the high bit", () => {
  for (const offset of [0, 8]) {
    const bytes = Buffer.from([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]);
    bytes[offset] = bytes[offset]! | 0x80;
    expect(detectImageMimeType(bytes)).toBeNull();
  }
});

function warnings(url: string, headers?: Record<string, string>, query?: Record<string, string>) {
  return preflightBundleSecrets({
    root: { type: "button", onTap: [{ type: "request", url, headers, query }] },
  });
}

const headers = ["Authorization", "Proxy-Authorization", "Cookie", "X-Api-Key", "X-Auth-Token"];
for (const name of headers) {
  test(`secret header ${name}`, () => {
    expect(warnings("https://example.com", { [name.toUpperCase()]: "hidden-value" })).toEqual([
      { code: "secret_header", path: "root.onTap[0].headers", name: name.toUpperCase() },
    ]);
  });
}
const keys = [
  "token",
  "access_token",
  "id_token",
  "refresh_token",
  "key",
  "api_key",
  "apikey",
  "secret",
  "client_secret",
  "sig",
  "signature",
  "password",
];
for (const key of keys) {
  test(`secret query ${key} in absolute, relative, templated and explicit queries`, () => {
    const name = key.toUpperCase();
    for (const prefix of ["https://example.com/x", "/relative", "{{base}}/x"]) {
      const encoded = `%${name.charCodeAt(0).toString(16)}${name.slice(1)}`;
      expect(warnings(`${prefix}?page=1&${encoded}=hidden-value#fragment`)).toEqual([
        { code: "secret_query", path: "root.onTap[0].query", name },
      ]);
    }
    expect(warnings("https://example.com", undefined, { [name]: "hidden-value" })).toEqual([
      { code: "secret_query", path: "root.onTap[0].query", name },
    ]);
  });
}
for (const host of [
  "service.internal",
  "service.local",
  "service.lan",
  "service.localhost",
  "metadata.google.internal",
  "SERVICE.INTERNAL.",
  "169.254.169.254",
]) {
  test(`offline internal host ${host}`, () => {
    expect(warnings(`https://${host}/`)).toEqual([
      {
        code: "private_host",
        path: "root.onTap[0].url",
        name: host.toLowerCase().replace(/\.$/, ""),
      },
    ]);
  });
}
for (const userinfo of ["user:pw", "user", ":pw"]) {
  test(`URL userinfo ${userinfo} warns without exposing credentials`, () => {
    expect(warnings(`https://${userinfo}@example.com/`)).toEqual([
      { code: "secret_userinfo", path: "root.onTap[0].url", name: "userinfo" },
    ]);
  });
}
test("relative query parsing ignores fragments and tolerates malformed percent escapes", () => {
  expect(warnings("/relative?bad%=x&ToKeN=hidden-value#?password=hidden-value")).toEqual([
    { code: "secret_query", path: "root.onTap[0].query", name: "ToKeN" },
  ]);
  expect(warnings("/relative#?token=hidden-value")).toEqual([]);
  expect(warnings("https://service.internal.example.com/?page=1")).toEqual([]);
});
test("strict JSON preserves escaped strings, scalar pairs, distinct keys and finite numbers", () => {
  const json = String.raw`{"a":"a\\\"b,{:}","b":"\uD83D\uDE00","nested":[{"a":1e3},{"a":-0.2}],"__proto__":{},"text":"token:1e400"}`;
  expect(parseBundleJson(json, "spec.json")).toEqual(JSON.parse(json));
});
for (const entry of ["bundle.json", "spec.json"] as const) {
  for (const text of [
    String.raw`{"a":{},"\u0061":{}}`,
    String.raw`{"a":[{"b":1,"b":2}]}`,
    String.raw`{"\uD800":0}`,
    String.raw`{"a":"\uD800x\uDC00"}`,
    '{"a":-1e400}',
  ]) {
    test(`strict JSON ${entry} refuses ${text}`, () => {
      expect(() => parseBundleJson(text, entry)).toThrow(
        entry === "bundle.json" ? "manifest_invalid" : "spec_invalid",
      );
    });
  }
}
