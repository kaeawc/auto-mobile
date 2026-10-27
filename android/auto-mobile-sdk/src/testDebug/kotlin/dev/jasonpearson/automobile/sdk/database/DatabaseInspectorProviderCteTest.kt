package dev.jasonpearson.automobile.sdk.database

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Regression coverage for the debug-only database inspector provider. */
@RunWith(RobolectricTestRunner::class)
internal class DatabaseInspectorProviderCteTest : DatabaseInspectorProviderTestBase() {
  @Test
  fun `read-only CTE is allowed when mutation capability is unsupported`() {
    val response =
      provider.handleExecuteSQL(
        driver,
        executeSqlExtras("WITH result(value) AS (SELECT 1) SELECT value FROM result"),
      )

    assertEquals("query", response.getString("type"))
    assertEquals(1, response.getJSONArray("rows").getJSONArray(0).getInt(0))
  }

  @Test
  fun `read-only CTE treats dollar signs as identifier characters`() {
    val response =
      provider.handleExecuteSQL(
        driver,
        executeSqlExtras("WITH foo\$update AS (VALUES(1)) SELECT * FROM foo\$update"),
      )

    assertEquals("query", response.getString("type"))
    assertEquals(1, response.getJSONArray("rows").getJSONArray(0).getInt(0))
  }

  @Test
  fun `read-only CTE treats non-ASCII characters as identifier characters`() {
    val response =
      provider.handleExecuteSQL(
        driver,
        executeSqlExtras("WITH foo😀update AS (VALUES(1)) SELECT * FROM foo😀update"),
      )

    assertEquals("query", response.getString("type"))
    assertEquals(1, response.getJSONArray("rows").getJSONArray(0).getInt(0))
  }

  @Test
  fun `read-only CTE may use a statement keyword as its identifier`() {
    val response =
      provider.handleExecuteSQL(
        driver,
        executeSqlExtras("WITH pragma(value) AS (VALUES(1)) SELECT value FROM pragma"),
      )

    assertEquals("query", response.getString("type"))
    assertEquals(1, response.getJSONArray("rows").getJSONArray(0).getInt(0))
  }
}
