package dev.jasonpearson.automobile.sdk.database

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Regression coverage for the debug-only database inspector provider. */
@RunWith(RobolectricTestRunner::class)
internal class DatabaseInspectorProviderMutationPolicyTest : DatabaseInspectorProviderTestBase() {
  @Test
  fun `permitted follow-up read preserves writable connection session`() {
    driver.executeSQL(databasePath, "CREATE TEMP TABLE session_notes (body TEXT NOT NULL)")
    driver.executeSQL(databasePath, "INSERT INTO session_notes (body) VALUES ('still here')")

    val result = driver.executeSQL(databasePath, "SELECT body FROM session_notes")

    assertEquals(
      listOf(listOf("still here")),
      (result as SQLExecutionResult.Query).rows,
    )
  }

  @Test
  fun `non-query SQL is rejected before it can mutate the database or filesystem`() {
    listOf(
        "INSERT INTO notes (id, body) VALUES (2, 'blocked')",
        "CREATE TABLE blocked (id INTEGER)",
        "VACUUM INTO '${vacuumCopyFile.sqlPath()}'",
        "ATTACH DATABASE '${attachedDatabaseFile.sqlPath()}' AS attached",
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

    assertTrue(!vacuumCopyFile.exists())
    assertTrue(!attachedDatabaseFile.exists())
    val rows =
      provider.handleExecuteSQL(driver, executeSqlExtras("SELECT id FROM notes ORDER BY id"))
    assertEquals(1, rows.getJSONArray("rows").length())
    assertEquals(1, rows.getJSONArray("rows").getJSONArray(0).getInt(0))
    assertTrue("blocked" !in driver.getTables(databasePath))
  }

  @Test
  fun `row-returning mutation cannot write through the read-only policy path`() {
    val query = "INSERT INTO notes (id, body) VALUES (2, 'blocked') RETURNING id"

    val error = runCatching {
      provider.handleExecuteSQL(driver, executeSqlExtras(query))
    }
      .exceptionOrNull()
    val rows =
      provider.handleExecuteSQL(driver, executeSqlExtras("SELECT id FROM notes ORDER BY id"))

    assertTrue(error is DatabaseError.MutationNotAllowed)
    assertEquals(1, rows.getJSONArray("rows").length())
    assertEquals(1, rows.getJSONArray("rows").getJSONArray(0).getInt(0))
  }

  @Test
  fun `custom driver SQL is blocked when mutation capability is unsupported`() {
    val customDriver = RecordingDatabaseDriver()

    val error = runCatching {
      provider.handleExecuteSQL(customDriver, executeSqlExtras("SELECT 1 AS one"))
    }
      .exceptionOrNull()

    assertTrue(error is DatabaseError.MutationNotAllowed)
    assertEquals(0, customDriver.executeSqlCallCount)
  }

  @Test
  fun `disabled mutation policy enforces read-only SQL when capability is supported`() {
    val capabilities = mutationCapabilities(allowMutations = false)

    val queryResponse =
      provider.handleExecuteSQL(
        driver,
        executeSqlExtras("SELECT id FROM notes ORDER BY id"),
        capabilities,
      )
    val mutationError = runCatching {
      provider.handleExecuteSQL(
        driver,
        executeSqlExtras("INSERT INTO notes (id, body) VALUES (2, 'blocked')"),
        capabilities,
      )
    }
      .exceptionOrNull()

    assertEquals("query", queryResponse.getString("type"))
    assertEquals(1, queryResponse.getJSONArray("rows").length())
    assertTrue(mutationError is DatabaseError.MutationNotAllowed)
  }

  @Test
  fun `enabled mutation policy uses writable SQL when capability is supported`() {
    val capabilities = mutationCapabilities(allowMutations = true)

    val response =
      provider.handleExecuteSQL(
        driver,
        executeSqlExtras("INSERT INTO notes (id, body) VALUES (2, 'allowed')"),
        capabilities,
      )

    assertEquals("mutation", response.getString("type"))
    assertEquals(1, response.getInt("rowsAffected"))
  }

  @Test
  fun `host read-only flag refuses a write disguised as a read even when mutations are allowed`() {
    val capabilities = mutationCapabilities(allowMutations = true)
    val disguised =
      listOf(
        "WITH a AS (SELECT ')' UNION SELECT 1) DELETE FROM notes",
        "WITH a AS (SELECT 1 /* ) */ UNION SELECT 2) UPDATE notes SET body = 'x'",
        "INSERT INTO notes (id, body) VALUES (2, 'blocked') RETURNING id",
        "DELETE FROM notes",
      )

    disguised.forEach { query ->
      val error = runCatching {
        provider.handleExecuteSQL(
          driver,
          executeSqlExtras(query).apply { putString("readOnly", "true") },
          capabilities,
        )
      }
        .exceptionOrNull()
      assertTrue(
        "Expected MutationNotAllowed for $query, got $error",
        error is DatabaseError.MutationNotAllowed,
      )
    }
    val rows =
      provider.handleExecuteSQL(driver, executeSqlExtras("SELECT body FROM notes"), capabilities)
    assertEquals(1, rows.getJSONArray("rows").length())
    assertEquals("hello", rows.getJSONArray("rows").getJSONArray(0).getString(0))
  }

  @Test
  fun `host read-only flag still runs reads when mutations are allowed`() {
    val response =
      provider.handleExecuteSQL(
        driver,
        executeSqlExtras("SELECT body FROM notes").apply { putString("readOnly", "true") },
        mutationCapabilities(allowMutations = true),
      )

    assertEquals("query", response.getString("type"))
  }

  @Test
  fun `multiple statements take precedence over mutation policy on both provider paths`() {
    driver.executeSQL(databasePath, "CREATE TABLE backup AS SELECT * FROM notes")
    listOf(true, false).forEach { allowMutations ->
      listOf(
          "DELETE FROM notes; DELETE FROM backup",
          "SELECT 1; DELETE FROM notes",
          "PRAGMA table_info = notes; SELECT 1",
        )
        .forEach { query ->
          val error = runCatching {
            provider.handleExecuteSQL(
              driver,
              executeSqlExtras(query),
              mutationCapabilities(allowMutations),
            )
          }
            .exceptionOrNull()
          assertTrue("Expected SqlError for $query, got $error", error is DatabaseError.SqlError)
          assertEquals("SQL error: Multiple SQL statements are not supported", error?.message)
        }
    }
    assertEquals(1, driver.getTableData(databasePath, "notes", 10, 0).total)
    assertEquals(1, driver.getTableData(databasePath, "backup", 10, 0).total)
  }
}
