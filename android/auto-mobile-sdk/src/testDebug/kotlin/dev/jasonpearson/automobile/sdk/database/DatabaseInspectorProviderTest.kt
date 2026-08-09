package dev.jasonpearson.automobile.sdk.database

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.os.Bundle
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.capabilities.SdkCapabilityDescriptor
import dev.jasonpearson.automobile.sdk.capabilities.SdkCapabilityDocument
import dev.jasonpearson.automobile.sdk.capabilities.SdkCapabilityState
import dev.jasonpearson.automobile.sdk.capabilities.SdkCapturePolicy
import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

/** Regression coverage for the debug-only database inspector provider. */
@RunWith(RobolectricTestRunner::class)
class DatabaseInspectorProviderTest {
  private lateinit var context: Context
  private lateinit var databasePath: String
  private lateinit var driver: SQLiteDatabaseDriver
  private lateinit var attachedDatabaseFile: File
  private lateinit var vacuumCopyFile: File
  private val provider = DatabaseInspectorProvider()

  @Before
  fun setUp() {
    AutoMobileSDK.shutdown()
    context = RuntimeEnvironment.getApplication()
    val databaseFile = context.getDatabasePath("database-inspector-provider-test.db")
    databaseFile.parentFile?.mkdirs()
    databaseFile.delete()
    SQLiteDatabase.openOrCreateDatabase(databaseFile, null).use { database ->
      database.execSQL("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)")
      database.execSQL("INSERT INTO notes (id, body) VALUES (1, 'hello')")
      database.execSQL("CREATE INDEX notes_body_idx ON notes(body)")
    }
    databasePath = databaseFile.absolutePath
    attachedDatabaseFile = context.getDatabasePath("database-inspector-attached-test.db")
    vacuumCopyFile = context.getDatabasePath("database-inspector-vacuum-test.db")
    attachedDatabaseFile.delete()
    vacuumCopyFile.delete()
    driver = SQLiteDatabaseDriver(context)
  }

  @After
  fun tearDown() {
    driver.closeAll()
    context.getDatabasePath("database-inspector-provider-test.db").delete()
    attachedDatabaseFile.delete()
    vacuumCopyFile.delete()
    AutoMobileSDK.shutdown()
  }

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
  fun `unrestricted leading-comment select returns query rows`() {
    val result = driver.executeSQL(databasePath, "-- inspect\nSELECT 1 AS one")

    assertEquals(
      listOf(listOf(1L)),
      (result as SQLExecutionResult.Query).rows,
    )
  }

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
        "PRAGMA table_info = notes; SELECT 1",
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

  private fun mutationCapabilities(allowMutations: Boolean) =
    SdkCapabilityDocument(
      capabilities =
        listOf(SdkCapabilityDescriptor("storage.mutation", SdkCapabilityState.SUPPORTED)),
      policy = SdkCapturePolicy(allowMutations = allowMutations),
    )

  private fun executeSqlExtras(query: String) =
    Bundle().apply {
      putString("databasePath", databasePath)
      putString("query", query)
    }

  private fun File.sqlPath(): String = absolutePath.replace("'", "''")

  private class RecordingDatabaseDriver : DatabaseDriver {
    var executeSqlCallCount = 0
      private set

    override fun getDatabases() = emptyList<DatabaseDescriptor>()

    override fun getTables(databasePath: String) = emptyList<String>()

    override fun getTableData(databasePath: String, table: String, limit: Int, offset: Int) =
      TableDataResult(emptyList(), emptyList(), 0)

    override fun getTableStructure(databasePath: String, table: String) =
      TableStructureResult(emptyList())

    override fun executeSQL(databasePath: String, query: String): SQLExecutionResult {
      executeSqlCallCount++
      return SQLExecutionResult.Query(emptyList(), emptyList())
    }
  }
}
