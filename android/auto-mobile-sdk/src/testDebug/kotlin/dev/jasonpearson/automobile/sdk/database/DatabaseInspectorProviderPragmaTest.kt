package dev.jasonpearson.automobile.sdk.database

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Regression coverage for the debug-only database inspector provider. */
@RunWith(RobolectricTestRunner::class)
internal class DatabaseInspectorProviderPragmaTest : DatabaseInspectorProviderTestBase() {
  @Test
  fun `observational pragmas allow trailing comments`() {
    listOf(
        "PRAGMA user_version; -- inspect",
        "PRAGMA application_id /* read */",
      )
      .forEach { query ->
        val response = provider.handleExecuteSQL(driver, executeSqlExtras(query))

        assertEquals("Expected query response for $query", "query", response.getString("type"))
      }
  }

  @Test
  fun `observational pragmas allow inter-token comments and quoted identifiers`() {
    listOf(
        "PRAGMA /* inspect */ user_version",
        "PRAGMA \"user_version\"",
        "PRAGMA [user_version]",
        "PRAGMA `user_version`",
      )
      .forEach { query ->
        val response = provider.handleExecuteSQL(driver, executeSqlExtras(query))

        assertEquals("Expected query response for $query", "query", response.getString("type"))
      }
  }

  @Test
  fun `argument-taking read-only pragma is allowed when mutation capability is unsupported`() {
    val tableInfo = provider.handleExecuteSQL(driver, executeSqlExtras("PRAGMA table_info(notes)"))
    val equalsTableInfo =
      provider.handleExecuteSQL(driver, executeSqlExtras("PRAGMA table_info = notes"))
    val quotedEqualsTableInfo =
      provider.handleExecuteSQL(driver, executeSqlExtras("PRAGMA table_info = 'notes'"))
    val indexInfo =
      provider.handleExecuteSQL(driver, executeSqlExtras("PRAGMA index_info(notes_body_idx)"))

    listOf("PRAGMA quick_check(1.0)", "PRAGMA quick_check(1e1)").forEach { query ->
      val response = provider.handleExecuteSQL(driver, executeSqlExtras(query))
      assertEquals("Expected query response for $query", "query", response.getString("type"))
    }

    assertEquals("query", tableInfo.getString("type"))
    assertEquals("name", tableInfo.getJSONArray("columns").getString(1))
    assertEquals("id", tableInfo.getJSONArray("rows").getJSONArray(0).getString(1))
    assertEquals(tableInfo.toString(), equalsTableInfo.toString())
    assertEquals(tableInfo.toString(), quotedEqualsTableInfo.toString())
    assertEquals("body", indexInfo.getJSONArray("rows").getJSONArray(0).getString(2))
  }

  @Test
  fun `writable pragmas are blocked by an actual read-only connection`() {
    driver.executeSQL(databasePath, "UPDATE notes SET body = body WHERE id = 1")

    listOf(
        "PRAGMA user_version=42",
        "PRAGMA user_version(42)",
        "PRAGMA /* blocked */ \"user_version\"=42",
      )
      .forEach { query ->
        val error = runCatching {
          provider.handleExecuteSQL(driver, executeSqlExtras(query))
        }
          .exceptionOrNull()

        assertTrue(
          "Expected MutationNotAllowed for $query, got $error",
          error is DatabaseError.MutationNotAllowed,
        )
      }
  }

  @Test
  fun `process-mutating pragmas fail the read-only admission gate`() {
    listOf(
        "PRAGMA hard_heap_limit=1",
        "PRAGMA hard_heap_limit(1)",
        "PRAGMA [hard_heap_limit]=1",
        "PRAGMA shrink_memory",
        "EXPLAIN PRAGMA hard_heap_limit=1",
        "EXPLAIN \uFEFFPRAGMA hard_heap_limit=1",
      )
      .forEach { query ->
        assertTrue(driver.isMutationQuery(query))

        val error = runCatching {
          provider.handleExecuteSQL(driver, executeSqlExtras(query))
        }
          .exceptionOrNull()
        assertTrue(
          "Expected MutationNotAllowed for $query, got $error",
          error is DatabaseError.MutationNotAllowed,
        )
      }
  }

  @Test
  fun `observational pragma arguments fail closed on extra or missing syntax`() {
    listOf(
        "PRAGMA table_info =",
        "PRAGMA table_info = notes extra",
        "PRAGMA table_info(notes) extra",
        "PRAGMA quick_check(1e)",
        "PRAGMA quick_check(.)",
      )
      .forEach { query ->
        assertTrue("Expected mutation classification for $query", driver.isMutationQuery(query))

        val error = runCatching {
          provider.handleExecuteSQL(driver, executeSqlExtras(query))
        }
          .exceptionOrNull()
        assertTrue(
          "Expected MutationNotAllowed for $query, got $error",
          error is DatabaseError.MutationNotAllowed,
        )
      }
  }

  @Test
  fun `authorized pragma setter uses the writable connection`() {
    driver.executeSQL(databasePath, "PRAGMA user_version=42")

    val result = driver.executeSQL(databasePath, "PRAGMA user_version")

    assertEquals(
      listOf(listOf(42L)),
      (result as SQLExecutionResult.Query).rows,
    )
  }
}
