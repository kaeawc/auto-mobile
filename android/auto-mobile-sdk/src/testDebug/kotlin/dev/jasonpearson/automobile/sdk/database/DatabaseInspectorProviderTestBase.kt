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
import org.junit.Before
import org.robolectric.RuntimeEnvironment

/** Regression coverage for the debug-only database inspector provider. */
internal abstract class DatabaseInspectorProviderTestBase {
  protected lateinit var context: Context
  protected lateinit var databasePath: String
  protected lateinit var driver: SQLiteDatabaseDriver
  protected lateinit var attachedDatabaseFile: File
  protected lateinit var vacuumCopyFile: File
  protected val provider = DatabaseInspectorProvider()

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

  protected fun mutationCapabilities(allowMutations: Boolean) =
    SdkCapabilityDocument(
      capabilities =
        listOf(SdkCapabilityDescriptor("storage.mutation", SdkCapabilityState.SUPPORTED)),
      policy = SdkCapturePolicy(allowMutations = allowMutations),
    )

  protected fun executeSqlExtras(query: String) =
    Bundle().apply {
      putString("databasePath", databasePath)
      putString("query", query)
    }

  protected fun File.sqlPath(): String = absolutePath.replace("'", "''")

  protected class RecordingDatabaseDriver : DatabaseDriver {
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
