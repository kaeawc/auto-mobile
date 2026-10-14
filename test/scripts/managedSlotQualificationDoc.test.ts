import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";

interface RefusalPayload {
  code?: string;
  retryable?: boolean;
  message?: string;
  nextAction?: string;
  error?:
    | string
    | {
        code: string;
        retryable?: boolean;
        message?: string;
        nextAction?: string;
        acquisitionFailure?: { code: string; retryable: boolean; nextAction?: string };
      };
}
describe("managed-slot qualification documentation", () => {
  let doc: string;
  let nav: string;
  let compatibility: Array<{ id: string; supported: boolean; outcome: string; verifiedBy: string }>;
  let expected: Array<{ code: string; retryable: boolean; client: string; guidance?: string }>;
  let sourceReferences: Array<{ path: string; exists: boolean }>;
  let rows: string[][];
  let compatibilityRows: string[][];
  beforeAll(() => {
    const root = new URL("../../", import.meta.url);
    doc = readFileSync(new URL("docs/using/managed-slot-qualification.md", root), "utf8");
    nav = readFileSync(new URL("mkdocs.yml", root), "utf8");
    compatibility = JSON.parse(
      readFileSync(new URL("schemas/managed-slot-contract.json", root), "utf8"),
    ).compatibility;
    compatibilityRows = doc
      .split("## Contract and compatibility")[1]
      .split("## Recording cases")[0]
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .map((line) =>
        line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim()),
      );
    const dir = new URL("test/fixtures/refusal-wire/", root);
    const expectations: { codes: Record<string, { expected: string }> } = JSON.parse(
      readFileSync(new URL("expectations.json", dir), "utf8"),
    );
    expected = [];
    const extras = new Set([
      "managed_slot_acquisition_failed",
      "device_assigned_to_managed_slot",
      "device_outside_managed_slots",
      "managed_slot_ownership_unconfirmed",
      "managed_execution_ended",
    ]);
    for (const name of readdirSync(dir).filter(
      (name) => name.endsWith(".json") && name !== "expectations.json",
    )) {
      const key = name.slice(0, -5);
      if (
        !key.startsWith("managed_slot_acquisition_failed.") &&
        !extras.has(key.split(".")[0]) &&
        !(key.startsWith("session_ownership_lost.") && key.includes("managed_slot_ownership_lost"))
      ) {
        continue;
      }
      const fixture: {
        result: { structuredContent?: RefusalPayload; content: Array<{ text: string }> };
      } = JSON.parse(readFileSync(new URL(name, dir), "utf8"));
      const payload: RefusalPayload =
        fixture.result.structuredContent ?? JSON.parse(fixture.result.content[0].text);
      const error = typeof payload.error === "object" ? payload.error : payload;
      const client = expectations.codes[key].expected;
      if (typeof payload.error === "object" && payload.error.acquisitionFailure) {
        expected.push({
          ...payload.error.acquisitionFailure,
          client,
          guidance: payload.error.acquisitionFailure.nextAction,
        });
      }
      if (!error.code) {
        throw new Error(`Missing refusal code in ${name}`);
      }
      expected.push({
        code: error.code,
        retryable: error.retryable ?? false,
        client,
        guidance: error.nextAction ?? payload.message,
      });
    }
    rows = doc
      .split("## Retry and recovery by failure code")[1]
      .split("## What qualification still requires")[0]
      .split("\n")
      .filter((line) => /^\| `/.test(line))
      .map((line) =>
        line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim()),
      );
    sourceReferences = rows.flatMap((row) =>
      [...row[3].matchAll(/\((src\/[^)\s:]+)(?:[^)]*)\)/g)].map((match) => ({
        path: match[1],
        exists: existsSync(new URL(match[1], root)),
      })),
    );
  });
  test("exactly one table row per typed code, matching all refusal fixtures", () => {
    const codes = [...new Set(expected.map((row) => row.code))].sort();
    expect(rows.map((row) => row[0].slice(1, -1)).sort()).toEqual(codes);
    for (const item of expected) {
      const matching = rows.filter((row) => row[0] === `\`${item.code}\``);
      expect(matching).toHaveLength(1);
      expect(matching[0][1]).toBe(item.retryable ? "yes" : "no");
      expect(matching[0][2]).toBe(item.client);
      expect(matching[0][3].length).toBeGreaterThan(0);
      if (item.guidance && item.guidance !== "Retry." && !item.guidance.endsWith("fixture")) {
        expect(matching[0][3]).toContain(item.guidance);
      }
    }
  });
  test("every parenthesized source path exists", () => {
    expect(sourceReferences.length).toBeGreaterThan(0);
    for (const reference of sourceReferences) {
      expect(reference.exists, reference.path).toBe(true);
    }
  });
  test("navigation immediately follows managed device slots", () => {
    expect(nav).toContain(
      '      - "Managed device slots": using/managed-slots.md\n      - "Managed-slot qualification": using/managed-slot-qualification.md',
    );
  });
  test("every compatibility row is present with matching columns", () => {
    for (const row of compatibility) {
      expect(compatibilityRows.filter((cells) => cells[0] === row.id)).toEqual([
        [row.id, row.supported ? "yes" : "no", row.outcome, row.verifiedBy],
      ]);
    }
    expect(doc).toContain("registry.olderBuildOnNewerRegistry");
  });
});
