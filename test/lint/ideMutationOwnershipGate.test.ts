import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every device-mutating `ide/*` socket route must reach the ownership check (#10827), as `input/*`
 * does. A source scan: "check ownership before acting" is an ordering obligation no signature
 * can express. Reads (watching) are deliberately absent from this list.
 */
describe("mutating ide/* routes reach the device ownership gate (#10827)", () => {
  const source = readFileSync(
    join(import.meta.dir, "..", "..", "src", "daemon", "socketServer.ts"),
    "utf8",
  );
  const GATE = "assertIdeMutationOwnership(";

  function caseBody(route: string): string {
    const start = source.indexOf(`case "${route}":`);
    expect(start).toBeGreaterThan(-1);
    const next = source.indexOf("\n      case ", start + 1);
    return source.slice(start, next === -1 ? undefined : next);
  }

  test("ide/updateService calls the gate", () => {
    expect(caseBody("ide/updateService")).toContain(GATE);
  });

  test("key-value mutation routes resolve through the gated client resolver", () => {
    for (const route of ["ide/setKeyValue", "ide/removeKeyValue", "ide/clearKeyValueFile"]) {
      expect(caseBody(route)).toContain("resolveKeyValueMutationClient(");
    }
    const resolverStart = source.indexOf("private async resolveKeyValueMutationClient(");
    const resolverEnd = source.indexOf("\n  }\n", resolverStart);
    expect(source.slice(resolverStart, resolverEnd)).toContain(GATE);
  });
});
