import { describe, expect, test } from "bun:test";
import { isMutationQuery, isReadOnlySqlQuery } from "../../src/server/databaseTools";

describe("isMutationQuery", () => {
  test("classifies plain mutations", () => {
    expect(isMutationQuery("DELETE FROM t")).toBe(true);
    expect(isMutationQuery("insert into t values (1)")).toBe(true);
    expect(isMutationQuery("UPDATE t SET a = 1")).toBe(true);
    expect(isMutationQuery("ALTER TABLE t ADD COLUMN a")).toBe(true);
    expect(isMutationQuery("DROP TABLE t")).toBe(true);
    expect(isMutationQuery("REPLACE INTO t VALUES (1)")).toBe(true);
  });

  test("classifies reads as non-mutations", () => {
    expect(isMutationQuery("SELECT * FROM t")).toBe(false);
    expect(isMutationQuery("WITH cte AS (SELECT 1) SELECT * FROM cte")).toBe(false);
    expect(isMutationQuery("PRAGMA user_version")).toBe(false);
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

  test("conservatively classifies CTE REPLACE and PRAGMA writes", () => {
    expect(isMutationQuery("WITH cte AS (SELECT 1) REPLACE INTO t VALUES (1)")).toBe(true);
    expect(isMutationQuery("PRAGMA user_version = 42")).toBe(true);
    expect(isMutationQuery("some unknown statement")).toBe(true);
  });

  test("still treats a commented-out read as a non-mutation", () => {
    expect(isMutationQuery("/* just looking */ SELECT * FROM t")).toBe(false);
  });
});

describe("isReadOnlySqlQuery", () => {
  test("accepts a single read and trailing semicolons", () => {
    expect(isReadOnlySqlQuery("SELECT * FROM t")).toBe(true);
    expect(isReadOnlySqlQuery("  select 1;; \n")).toBe(true);
    expect(isReadOnlySqlQuery("WITH c AS (SELECT 1) SELECT * FROM c")).toBe(true);
    expect(isReadOnlySqlQuery("PRAGMA user_version")).toBe(true);
  });

  test("rejects mutations, unknown statements, and anything after a semicolon", () => {
    expect(isReadOnlySqlQuery("DELETE FROM t")).toBe(false);
    expect(isReadOnlySqlQuery("PRAGMA user_version = 1")).toBe(false);
    expect(isReadOnlySqlQuery("BEGIN")).toBe(false);
    expect(isReadOnlySqlQuery("SELECT 1; DELETE FROM t")).toBe(false);
  });
});

describe("statement boundaries hidden in literals and comments (#10966)", () => {
  // Each of these used to read as a CTE SELECT: the classifier counted a `)` inside a literal,
  // comment or quoted identifier, closed the CTE early and found the SELECT inside it.
  const disguisedWrites = [
    "WITH a AS (SELECT ')' UNION SELECT 1) DELETE FROM t",
    "WITH a AS (SELECT 1 /* ) */ UNION SELECT 2) DELETE FROM t",
    "WITH a AS (SELECT 1 -- )\n UNION SELECT 2) DELETE FROM t",
    'WITH a AS (SELECT ")" UNION SELECT 1) DELETE FROM t',
    "WITH a AS (SELECT [)] UNION SELECT 1) UPDATE t SET b = ')'",
    "WITH a AS (SELECT `)` UNION SELECT 1) INSERT INTO t VALUES (1)",
    "WITH a AS (SELECT 'it''s )' UNION SELECT 1) DELETE FROM t",
  ];

  for (const query of disguisedWrites) {
    test(`classifies as a write: ${query}`, () => {
      expect(isReadOnlySqlQuery(query)).toBe(false);
      expect(isMutationQuery(query)).toBe(true);
    });
  }

  test("a statement after a ';' outside any literal is a second statement", () => {
    expect(isReadOnlySqlQuery("SELECT 1 /* ; */; DELETE FROM t")).toBe(false);
    expect(isMutationQuery("SELECT 1; DELETE FROM t")).toBe(true);
    expect(isMutationQuery("SELECT 1; SELECT 2")).toBe(false);
    expect(isReadOnlySqlQuery("SELECT 1; SELECT 2")).toBe(false);
  });

  test("a ';' or keyword inside a literal, identifier or comment is not a statement", () => {
    expect(isReadOnlySqlQuery("SELECT ';'")).toBe(true);
    expect(isReadOnlySqlQuery("SELECT '; DELETE FROM t'")).toBe(true);
    expect(isReadOnlySqlQuery('SELECT "a;b" FROM t -- ; DROP TABLE t')).toBe(true);
    expect(isReadOnlySqlQuery("WITH a AS (SELECT ')(' AS x) SELECT * FROM a")).toBe(true);
    expect(isReadOnlySqlQuery('WITH "delete" AS (SELECT 1) SELECT * FROM "delete"')).toBe(true);
    expect(isReadOnlySqlQuery("WITH update_cte AS (SELECT 1) SELECT * FROM update_cte")).toBe(true);
  });

  test("unterminated literals, identifiers and comments are not read-only", () => {
    expect(isReadOnlySqlQuery("SELECT 'never closed")).toBe(false);
    expect(isReadOnlySqlQuery('SELECT "never closed')).toBe(false);
    expect(isReadOnlySqlQuery("SELECT 1 /* never closed")).toBe(false);
    expect(isMutationQuery("/* never closed DELETE FROM t")).toBe(true);
  });

  test("unbalanced CTE parentheses are not read-only", () => {
    expect(isReadOnlySqlQuery("WITH a AS (SELECT 1)) SELECT 1")).toBe(false);
  });

  test("an empty or comment-only query is not read-only", () => {
    expect(isReadOnlySqlQuery("")).toBe(false);
    expect(isReadOnlySqlQuery("-- nothing")).toBe(false);
    expect(isMutationQuery(";;")).toBe(true);
  });

  test("a schema-qualified read-only PRAGMA is a read; a quoted pragma name is not", () => {
    expect(isReadOnlySqlQuery("PRAGMA main.user_version")).toBe(true);
    expect(isReadOnlySqlQuery('PRAGMA "user_version"')).toBe(false);
    expect(isReadOnlySqlQuery("PRAGMA main.user_version = 3")).toBe(false);
  });
});
