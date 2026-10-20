package dev.jasonpearson.automobile.sdk.database

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Regression coverage for the debug-only database inspector provider. */
@RunWith(RobolectricTestRunner::class)
internal class DatabaseInspectorProviderReadQueryTest : DatabaseInspectorProviderTestBase() {
  @Test
  fun `read-only select is allowed when mutation capability is unsupported`() {
    val response = provider.handleExecuteSQL(driver, executeSqlExtras("SELECT 1 AS one"))

    assertEquals("query", response.getString("type"))
    assertEquals("one", response.getJSONArray("columns").getString(0))
    assertEquals(1, response.getJSONArray("rows").getJSONArray(0).getInt(0))
  }

  @Test
  fun `read-only values query is allowed when mutation capability is unsupported`() {
    val response = provider.handleExecuteSQL(driver, executeSqlExtras("VALUES (1)"))

    assertEquals("query", response.getString("type"))
    assertEquals(1, response.getJSONArray("rows").getJSONArray(0).getInt(0))
  }

  @Test
  fun `explain applies the read-only admission policy to its statement`() {
    listOf(
        "EXPLAIN SELECT 1",
        "EXPLAIN QUERY PLAN SELECT 1",
        "EXPLAIN PRAGMA user_version",
      )
      .forEach { query ->
        assertTrue("Expected read-only classification for $query", !driver.isMutationQuery(query))
      }
  }

  @Test
  fun `explain allows DML plans without executing the mutation`() {
    listOf(
        "EXPLAIN INSERT INTO notes (id, body) VALUES (2, 'not executed')",
        "EXPLAIN QUERY PLAN DELETE FROM notes WHERE id = 1",
      )
      .forEach { query ->
        val response = provider.handleExecuteSQL(driver, executeSqlExtras(query))
        assertEquals("Expected query response for $query", "query", response.getString("type"))
      }

    val rows =
      provider.handleExecuteSQL(driver, executeSqlExtras("SELECT id FROM notes ORDER BY id"))
    assertEquals(1, rows.getJSONArray("rows").length())
    assertEquals(1, rows.getJSONArray("rows").getJSONArray(0).getInt(0))
  }

  @Test
  fun `read-only SQL does not depend on comment-aware classification`() {
    val response =
      provider.handleExecuteSQL(
        driver,
        executeSqlExtras("-- note(foo)\nPRAGMA user_version"),
      )

    assertEquals("query", response.getString("type"))
    assertEquals("user_version", response.getJSONArray("columns").getString(0))
    assertEquals(0, response.getJSONArray("rows").getJSONArray(0).getInt(0))
  }

  @Test
  fun `read-only SQL allows a leading byte order mark`() {
    val response = provider.handleExecuteSQL(driver, executeSqlExtras("\uFEFFSELECT 1 AS one"))

    assertEquals("query", response.getString("type"))
    assertEquals(1, response.getJSONArray("rows").getJSONArray(0).getInt(0))
  }

  @Test
  fun `unrestricted leading-comment select returns query rows`() {
    val result = driver.executeSQL(databasePath, "-- inspect\nSELECT 1 AS one")

    assertEquals(
      listOf(listOf(1L)),
      (result as SQLExecutionResult.Query).rows,
    )
  }
}
