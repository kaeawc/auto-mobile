package dev.jasonpearson.automobile.sdk.database

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Regression coverage for the debug-only database inspector provider. */
@RunWith(RobolectricTestRunner::class)
internal class DatabaseInspectorProviderResponseTest : DatabaseInspectorProviderTestBase() {
  @Test
  fun `multiple statements return the diagnostic code in the provider error envelope`() {
    DatabaseInspector.initialize(context)
    DatabaseInspector.setEnabled(true)
    driver.executeSQL(databasePath, "CREATE TABLE backup AS SELECT * FROM notes")

    listOf(true, false).forEach { allowMutations ->
      val result =
        provider.callWithCapabilities(
          "executeSQL",
          executeSqlExtras("DELETE FROM notes; DELETE FROM backup"),
          mutationCapabilities(allowMutations),
        )

      assertTrue(!result.getBoolean("success"))
      val error = JSONObject(result.getString("result") ?: throw AssertionError("no result JSON"))
      assertEquals("multiple_statements_not_supported", error.getString("errorType"))
      assertEquals("Multiple SQL statements are not supported", error.getString("error"))
    }
    assertEquals(1, driver.getTableData(databasePath, "notes", 10, 0).total)
    assertEquals(1, driver.getTableData(databasePath, "backup", 10, 0).total)
  }

  @Test
  fun `read-only capability reports enforcement`() {
    DatabaseInspector.initialize(context)
    DatabaseInspector.setEnabled(true)

    val result =
      provider.callWithCapabilities("getReadOnlyCapability", null, mutationCapabilities(false))

    assertTrue(result.getBoolean("success"))
    val response = JSONObject(result.getString("result") ?: throw AssertionError("no result JSON"))
    assertEquals(1, response.length())
    assertTrue(response.getBoolean("readOnlyEnforced"))
  }

  @Test
  fun `ordinary sql errors retain their existing provider error type`() {
    DatabaseInspector.initialize(context)
    DatabaseInspector.setEnabled(true)

    val result = provider.call("executeSQL", null, executeSqlExtras("SELECT * FROM missing_table"))

    assertTrue(!result.getBoolean("success"))
    val error = JSONObject(result.getString("result") ?: throw AssertionError("no result JSON"))
    assertEquals("SqlError", error.getString("errorType"))
    assertTrue(error.getString("error").startsWith("SQL error:"))
  }

  @Test
  fun `disabled inspection tells the caller to launch the app first`() {
    DatabaseInspector.initialize(context)
    DatabaseInspector.setEnabled(false)

    val result = provider.call("executeSQL", null, executeSqlExtras("SELECT 1"))

    assertTrue(!result.getBoolean("success"))
    val error = JSONObject(result.getString("result") ?: throw AssertionError("no result JSON"))
    assertEquals("DISABLED", error.getString("errorType"))
    assertTrue(error.getString("error").contains("launch it first"))
  }
}
