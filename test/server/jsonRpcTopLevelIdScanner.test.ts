import { describe, expect, test } from "bun:test";
import { JsonRpcTopLevelIdScanner } from "../../src/server/jsonRpcTopLevelIdScanner";

function scan(...chunks: string[]): string | number | undefined {
  const scanner = new JsonRpcTopLevelIdScanner();
  for (const chunk of chunks) {
    scanner.push(Buffer.from(chunk, "utf8"));
  }
  return scanner.id;
}

describe("JsonRpcTopLevelIdScanner", () => {
  test("reads a numeric id that follows params, as SDK clients serialize it", () => {
    const message = JSON.stringify({
      method: "tools/call",
      params: { name: "putAppFile", arguments: { files: [{ contentBase64: "QUJD".repeat(50) }] } },
      jsonrpc: "2.0",
      id: 42,
    });
    expect(scan(message)).toBe(42);
  });

  test("reads a string id that precedes params", () => {
    expect(scan('{"jsonrpc":"2.0","id":"req-7","method":"tools/call","params":{}}')).toBe("req-7");
  });

  test("ignores an id nested in params or inside a string", () => {
    const message = '{"method":"x","params":{"id":1,"note":"\\"id\\":2"},"jsonrpc":"2.0"}';
    expect(scan(message)).toBeUndefined();
  });

  test("keeps escape and string state across chunk boundaries", () => {
    const message = '{"params":{"text":"a\\\\"},"id":9}';
    const pieces = message.split("");
    expect(scan(...pieces)).toBe(9);
  });

  test("decodes an escaped string id", () => {
    expect(scan('{"id":"a\\"b","method":"m"}')).toBe('a"b');
  });

  test("returns no id for a notification, a batch, or an object id", () => {
    expect(scan('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toBeUndefined();
    expect(scan('[{"jsonrpc":"2.0","id":1,"method":"ping"}]')).toBeUndefined();
    expect(scan('{"id":{"n":1},"method":"m"}')).toBeUndefined();
  });

  test("does not mistake a long key for id", () => {
    expect(scan(`{"${"k".repeat(100)}":3,"id":4}`)).toBe(4);
  });
});
