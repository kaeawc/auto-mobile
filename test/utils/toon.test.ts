import { describe, expect, test } from "bun:test";
import { encodeToonTable, decodeToonTable, type ToonScalar } from "../../src/utils/toon";

/**
 * Round-trip and escaping tests for the TOON (Token-Oriented Object Notation)
 * writer util (issue #2760). TOON encodes a uniform array of objects as a
 * `name[count]{col,...}:` header plus one indented CSV-style row per record, so
 * it drops the repeated braces/keys that JSON pays per element. The acceptance
 * bar for the issue is adversarial escaping fidelity: node `text` /
 * `content-desc` values carry arbitrary commas, quotes, and newlines, and none
 * of them may corrupt the row grid.
 *
 * Contract exercised here:
 *  - `null` / `undefined` / absent key  -> empty (unquoted) cell -> decodes to `null`.
 *  - empty string `""`                  -> quoted empty cell     -> decodes to `""`.
 *  - a cell needing quoting (`,`/`"`/newline/edge whitespace) is quoted, with
 *    inner `"` doubled, and survives a decode round-trip byte-for-byte.
 */

/** Decode helper: map a record through encode -> decode, returning the single row. */
function roundTripRow(record: Record<string, ToonScalar>): (string | null)[] {
  const block = encodeToonTable("t", [record]);
  const table = decodeToonTable(block);
  return table.rows[0];
}

describe("encodeToonTable / decodeToonTable", () => {
  test("header carries name, count, and union of columns in first-seen order", () => {
    const block = encodeToonTable("clickable", [
      { a: 1, b: 2 },
      { a: 3, c: 4 },
    ]);
    const firstLine = block.split("\n")[0];
    expect(firstLine).toBe("clickable[2]{a,b,c}:");
  });

  test("empty array yields a zero-count header and no data rows", () => {
    const block = encodeToonTable("text", []);
    expect(block).toBe("text[0]{}:");
    const table = decodeToonTable(block);
    expect(table.name).toBe("text");
    expect(table.columns).toEqual([]);
    expect(table.rows).toEqual([]);
  });

  test("data rows are indented and comma-joined in column order", () => {
    const block = encodeToonTable("m", [{ x: 1, y: "hi" }]);
    const lines = block.split("\n");
    expect(lines[0]).toBe("m[1]{x,y}:");
    expect(lines[1]).toBe("  1,hi");
  });

  test("scalars round-trip as their string form", () => {
    expect(roundTripRow({ n: 42, f: 3.5, b: true, z: false })).toEqual([
      "42",
      "3.5",
      "true",
      "false",
    ]);
  });

  test("null / undefined / absent decode to null; empty string decodes to \"\"", () => {
    // Column union is {present, empty, nullish}; the third record omits `present`.
    const block = encodeToonTable("t", [
      { present: "v", empty: "", nullish: null },
      { present: "w", empty: "", nullish: undefined },
    ]);
    const table = decodeToonTable(block);
    expect(table.columns).toEqual(["present", "empty", "nullish"]);
    expect(table.rows[0]).toEqual(["v", "", null]);
    expect(table.rows[1]).toEqual(["w", "", null]);
  });

  test("values with commas are quoted and round-trip intact", () => {
    const block = encodeToonTable("t", [{ label: "Wed, Jul 1" }]);
    expect(block.split("\n")[1]).toBe('  "Wed, Jul 1"');
    expect(roundTripRow({ label: "Wed, Jul 1" })).toEqual(["Wed, Jul 1"]);
  });

  test("embedded double quotes are doubled and round-trip intact", () => {
    const value = 'say "hi" now';
    const block = encodeToonTable("t", [{ label: value }]);
    expect(block.split("\n")[1]).toBe('  "say ""hi"" now"');
    expect(roundTripRow({ label: value })).toEqual([value]);
  });

  test("newlines and carriage returns survive a round-trip", () => {
    const value = "line1\nline2\r\nline3";
    expect(roundTripRow({ label: value })).toEqual([value]);
  });

  test("leading/trailing whitespace is preserved via quoting", () => {
    expect(roundTripRow({ label: "  padded  " })).toEqual(["  padded  "]);
  });

  test("adversarial mixed record round-trips every cell", () => {
    const record: Record<string, ToonScalar> = {
      "text": 'a,b,"c",\nd',
      "content-desc": "plain",
      "count": 7,
      "flag": false,
      "missing": null,
      "blank": "",
    };
    const block = encodeToonTable("clickable", [record]);
    const table = decodeToonTable(block);
    expect(table.columns).toEqual([
      "text",
      "content-desc",
      "count",
      "flag",
      "missing",
      "blank",
    ]);
    expect(table.rows[0]).toEqual(['a,b,"c",\nd', "plain", "7", "false", null, ""]);
  });

  test("multiple rows with ragged keys align to the shared column grid", () => {
    const block = encodeToonTable("t", [
      { a: "1", b: "2" },
      { b: "3", c: "4" },
    ]);
    const table = decodeToonTable(block);
    expect(table.columns).toEqual(["a", "b", "c"]);
    expect(table.rows[0]).toEqual(["1", "2", null]);
    expect(table.rows[1]).toEqual([null, "3", "4"]);
  });

  test("column names needing escaping round-trip", () => {
    const block = encodeToonTable("t", [{ "weird,name": "v", "normal": "w" }]);
    const table = decodeToonTable(block);
    expect(table.columns).toEqual(["weird,name", "normal"]);
    expect(table.rows[0]).toEqual(["v", "w"]);
  });

  test("column names containing newlines / braces / colons round-trip", () => {
    // The header terminator must be found quote-aware, not via a raw indexOf of
    // the first newline or `}` — otherwise a quoted column name containing one
    // would truncate the whole header.
    const block = encodeToonTable("t", [{ "we\nird}:": "v", "a,b": "w" }]);
    const table = decodeToonTable(block);
    expect(table.columns).toEqual(["we\nird}:", "a,b"]);
    expect(table.rows[0]).toEqual(["v", "w"]);
  });

  test("rejects a name that is not a bare identifier", () => {
    expect(() => encodeToonTable("bad name", [{ a: 1 }])).toThrow();
  });
});
