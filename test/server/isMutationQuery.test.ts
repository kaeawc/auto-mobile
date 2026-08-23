import { describe, expect, test } from "bun:test";
import { isMutationQuery, stripLeadingSqlNoise } from "../../src/server/databaseTools";

describe("isMutationQuery", () => {
  test("classifies plain mutations", () => {
    expect(isMutationQuery("DELETE FROM t")).toBe(true);
    expect(isMutationQuery("insert into t values (1)")).toBe(true);
    expect(isMutationQuery("UPDATE t SET a = 1")).toBe(true);
    expect(isMutationQuery("ALTER TABLE t ADD COLUMN a")).toBe(true);
    expect(isMutationQuery("DROP TABLE t")).toBe(true);
  });

  test("classifies reads as non-mutations", () => {
    expect(isMutationQuery("SELECT * FROM t")).toBe(false);
    expect(isMutationQuery("WITH cte AS (SELECT 1) SELECT * FROM cte")).toBe(false);
  });

  test("detects mutations behind a leading line comment", () => {
    // Regression for #3591: the mutation keyword is not the literal prefix.
    expect(isMutationQuery("-- purge stale rows\nDELETE FROM t")).toBe(true);
    expect(isMutationQuery("  -- indented\n  UPDATE t SET a = 1")).toBe(true);
  });

  test("detects mutations behind a leading block comment", () => {
    expect(isMutationQuery("/* migration */UPDATE t SET a = 1")).toBe(true);
    expect(isMutationQuery("/* multi\nline */ INSERT INTO t VALUES (1)")).toBe(true);
  });

  test("detects mutations behind stacked comments and whitespace", () => {
    expect(isMutationQuery("-- one\n/* two */\n\tDELETE FROM t")).toBe(true);
  });

  test("detects CTE mutations behind a leading comment", () => {
    expect(
      isMutationQuery(
        "-- cte\nWITH d AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM d)",
      ),
    ).toBe(true);
  });

  test("still treats a commented-out read as a non-mutation", () => {
    expect(isMutationQuery("/* just looking */ SELECT * FROM t")).toBe(false);
  });
});

describe("stripLeadingSqlNoise", () => {
  test("removes leading whitespace, line, and block comments", () => {
    expect(stripLeadingSqlNoise("  \n-- a\n/* b */ SELECT 1")).toBe("SELECT 1");
  });

  test("is a no-op for a bare statement", () => {
    expect(stripLeadingSqlNoise("SELECT 1")).toBe("SELECT 1");
  });

  test("handles an unterminated block comment without hanging", () => {
    expect(stripLeadingSqlNoise("/* never closed DELETE FROM t")).toBe("");
  });
});
