import { describe, expect, test } from "bun:test";
import { lexSql, splitSqlStatements } from "../../../src/features/database/sqlLexer";

describe("lexSql", () => {
  test("drops whitespace and comments and upper-cases bare words", () => {
    expect(lexSql("  select -- note\n a /* b */ FROM t").tokens).toEqual([
      { kind: "word", text: "SELECT" },
      { kind: "word", text: "A" },
      { kind: "word", text: "FROM" },
      { kind: "word", text: "T" },
    ]);
  });

  test("keeps literals and quoted identifiers whole, with doubled-quote escapes", () => {
    expect(lexSql(`'a'')' "b"";(" \`c)\` [d;]`).tokens).toEqual([
      { kind: "string", text: "'a'')'" },
      { kind: "identifier", text: '"b"";("' },
      { kind: "identifier", text: "`c)`" },
      { kind: "identifier", text: "[d;]" },
    ]);
  });

  test("emits punctuation and other runs", () => {
    expect(lexSql("f(1,x.y)>=2;").tokens.map((token) => token.text)).toEqual([
      "F",
      "(",
      "1",
      ",",
      "X",
      ".",
      "Y",
      ")",
      ">=2",
      ";",
    ]);
  });

  test("an operator run stops at a comment", () => {
    expect(lexSql("1+-- x\n2").tokens.map((token) => token.text)).toEqual(["1+", "2"]);
  });

  test("reports unterminated literals, identifiers and block comments", () => {
    expect(lexSql("'open").unterminated).toBe(true);
    expect(lexSql('"open').unterminated).toBe(true);
    expect(lexSql("[open").unterminated).toBe(true);
    expect(lexSql("/* open").unterminated).toBe(true);
    expect(lexSql("-- a line comment runs to the end").unterminated).toBe(false);
  });
});

describe("splitSqlStatements", () => {
  test("splits on ';' tokens and drops empty statements", () => {
    const statements = splitSqlStatements(lexSql("SELECT ';' ;; DELETE FROM t;").tokens);
    expect(statements.map((statement) => statement.map((token) => token.text))).toEqual([
      ["SELECT", "';'"],
      ["DELETE", "FROM", "T"],
    ]);
  });
});
