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

  private fun newDriver() =
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

  // #5581 — a stale registration handle must not remove a replacement registered under the same
  // name.
  @Test
  fun `stale registration handle does not remove a replacement`() {
    val firstReg = DatabaseInspector.registerDriver("room", newDriver())
    DatabaseInspector.registerDriver("room", newDriver()) // replaces first

    assertFalse(firstReg.unregister())
    assertEquals(setOf("room"), DatabaseInspector.registeredDriverNames())
  }

  // #5581 — a current registration handle removes only its own registration.
  @Test
  fun `current registration handle removes its driver`() {
    val reg = DatabaseInspector.registerDriver("room", newDriver())

    assertTrue(reg.unregister())
    assertTrue(DatabaseInspector.registeredDriverNames().isEmpty())
    assertFalse(reg.unregister())
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
