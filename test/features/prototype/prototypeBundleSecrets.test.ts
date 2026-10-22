import { expect, test } from "bun:test";
import { scanBundleForSecrets } from "../../../src/features/prototype/prototypeBundle";
function scan(value: unknown) {
  return scanBundleForSecrets(Buffer.from(JSON.stringify(value)));
}
test("structural request walk warns on case-insensitive headers and query keys", () => {
  const result = scan({
    root: {
      onTap: {
        type: "request",
        url: "https://example.com/?ToKeN=secret&KEY=x&Secret=y&SIG=z",
        headers: {
          aUtHoRiZaTiOn: "do-not-return",
          COOKIE: "secret",
          "X-Api-Key": "secret",
          Accept: "ok",
        },
      },
    },
  });
  expect(result.filter((w) => w.code === "credential_header")).toHaveLength(3);
  expect(result.filter((w) => w.code === "credential_query")).toHaveLength(4);
  expect(JSON.stringify(result).includes("do-not-return")).toBe(false);
});
for (const host of [
  "localhost",
  "127.0.0.1",
  "10.0.2.2",
  "192.168.1.1",
  "169.254.1.2",
  "[::1]",
  "[fe80::1]",
  "[::ffff:7f00:1]",
  "0x7f000001",
]) {
  test(`egress classifier warns for ${host}`, () => {
    expect(scan({ type: "request", url: `http://${host}/` })).toEqual([
      { code: "private_host", path: "$.url" },
    ]);
  });
}
test("public literals and DNS names produce no host warning or resolver activity", () => {
  expect(
    scan([
      { type: "request", url: "https://1.1.1.1/" },
      { type: "request", url: "https://example.com/" },
    ]),
  ).toEqual([]);
});
test("raw text resembling JSON requests is not scanned", () => {
  expect(scan({ text: '{"type":"request","headers":{"Authorization":"x"}}' })).toEqual([]);
});
test("malformed and templated URLs never block preflight", () => {
  expect(scan({ type: "request", url: "{data:/url}" })).toEqual([]);
  expect(scanBundleForSecrets(Buffer.from("{"))).toEqual([]);
});
