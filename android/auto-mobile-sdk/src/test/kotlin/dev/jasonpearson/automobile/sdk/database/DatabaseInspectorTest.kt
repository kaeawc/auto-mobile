package dev.jasonpearson.automobile.sdk.database

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class DatabaseInspectorTest {
  private val fakeDriver =
    object : DatabaseDriver {
      override fun getDatabases() = emptyList<DatabaseDescriptor>()

      override fun getTables(databasePath: String) = emptyList<String>()

      override fun getTableData(databasePath: String, table: String, limit: Int, offset: Int) =
        TableDataResult(emptyList(), emptyList(), 0)

      override fun getTableStructure(databasePath: String, table: String) =
        TableStructureResult(emptyList())

      override fun executeSQL(databasePath: String, query: String) =
        SQLExecutionResult.Query(emptyList(), emptyList())
    }

  @Before
  fun setUp() {
    DatabaseInspector.reset()
  }

  @Test
  fun `registered driver names are removable`() {
    DatabaseInspector.registerDriver("room", fakeDriver)

    assertEquals(setOf("room"), DatabaseInspector.registeredDriverNames())
    assertTrue(DatabaseInspector.unregisterDriver("room"))
    assertFalse(DatabaseInspector.unregisterDriver("room"))
  }

  @Test
  fun `unknown named driver does not fall back to default`() {
    try {
      DatabaseInspector.getDriver("missing")
      throw AssertionError("Expected DatabaseError.DriverNotFound")
    } catch (error: DatabaseError.DriverNotFound) {
      assertTrue(error.message!!.contains("missing"))
    }
  }
}
