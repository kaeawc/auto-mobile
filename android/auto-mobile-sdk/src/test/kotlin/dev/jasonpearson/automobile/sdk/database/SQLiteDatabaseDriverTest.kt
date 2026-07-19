package dev.jasonpearson.automobile.sdk.database

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import java.io.File
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class SQLiteDatabaseDriverTest {

  private lateinit var context: Context
  private val filesToDelete = mutableListOf<File>()

  @Before
  fun setup() {
    context = RuntimeEnvironment.getApplication()
  }

  @After
  fun tearDown() {
    filesToDelete.forEach { it.delete() }
  }

  @Test
  fun `rejects sibling data directory with same path prefix`() {
    val siblingPath = context.applicationInfo.dataDir + "-other/databases/outside.db"
    val driver = SQLiteDatabaseDriver(context)

    val error = kotlin.runCatching { driver.executeSQL(siblingPath, "SELECT 1") }.exceptionOrNull()

    assertTrue(error is DatabaseError.InvalidPath)
  }

  @Test
  fun `getDatabases lists each database once sorted by name excluding journal sidecars`() {
    val beta = createDatabase("zz-beta-${System.nanoTime()}.db")
    val alpha = createDatabase("aa-alpha-${System.nanoTime()}.db")
    // Sidecars sit next to a real database and must never be reported as databases
    // themselves. They are also the reason the discovery pass cannot be a bare listFiles().
    val sidecars =
      listOf("-journal", "-wal", "-shm").map { suffix ->
        File(alpha.parentFile, alpha.name + suffix).also {
          it.writeText("not a database")
          filesToDelete.add(it)
        }
      }

    val discovered = SQLiteDatabaseDriver(context).getDatabases()
    val names = discovered.map { it.name }

    // Both databases are reachable via BOTH context.databaseList() and the directory scan,
    // so a dedup regression would surface here as a duplicated entry.
    assertEquals(names.distinct(), names, "getDatabases must not report a database twice")
    assertEquals(discovered.map { it.path }.distinct(), discovered.map { it.path })
    assertTrue(
      names.containsAll(listOf(alpha.name, beta.name)),
      "expected both databases in $names",
    )
    sidecars.forEach { sidecar ->
      assertTrue(names.none { it == sidecar.name }, "sidecar ${sidecar.name} leaked into $names")
    }
    assertEquals(names.sorted(), names, "getDatabases must return entries sorted by name")
  }

  @Test
  fun `serializes parallel reads and writes through one driver`() {
    val dbFile = createDatabase("parallel-${System.nanoTime()}.db")
    val driver = SQLiteDatabaseDriver(context)
    val executor = Executors.newFixedThreadPool(8)
    val start = CountDownLatch(1)
    val errors = Collections.synchronizedList(mutableListOf<Throwable>())

    repeat(80) { index ->
      executor.execute {
        try {
          start.await(2, TimeUnit.SECONDS)
          if (index % 4 == 0) {
            driver.executeSQL(
              dbFile.absolutePath,
              "UPDATE items SET value = value + 1 WHERE id = 1",
            )
          } else {
            val data = driver.getTableData(dbFile.absolutePath, "items", 10, 0)
            assertEquals(listOf("id", "value"), data.columns)
            assertEquals(1, data.total)
          }
        } catch (error: Throwable) {
          errors.add(error)
        }
      }
    }

    start.countDown()
    executor.shutdown()
    assertTrue(executor.awaitTermination(10, TimeUnit.SECONDS))

    val finalData = driver.getTableData(dbFile.absolutePath, "items", 10, 0)
    assertEquals(20L, finalData.rows.single()[1])

    driver.closeAll()
    assertTrue(errors.isEmpty(), errors.joinToString("\n") { it.stackTraceToString() })
  }

  @Test
  fun `returning writes are classified as row returning and writable`() {
    val driver = SQLiteDatabaseDriver(context)

    listOf(
        "INSERT INTO notes (body) VALUES ('delta') RETURNING id, body",
        "UPDATE notes SET body = 'beta2' WHERE body = 'beta' RETURNING id, body",
        "DELETE FROM notes WHERE body = 'gamma' RETURNING id, body",
        """
        WITH target AS (
          SELECT id FROM notes WHERE body = 'alpha'
        )
        UPDATE notes SET body = 'alpha2'
        WHERE id IN (SELECT id FROM target)
        RETURNING id, body
        """
          .trimIndent(),
      )
      .forEach { query ->
        assertEquals(
          Classification(returnsRows = true, readOnly = false),
          classifySQL(driver, query),
          query,
        )
      }
  }

  @Test
  fun `returning inside a string literal does not make a mutation return rows`() {
    val dbFile = createNotesDatabase("returning-string-${System.nanoTime()}.db")
    val driver = SQLiteDatabaseDriver(context)

    assertEquals(
      Classification(returnsRows = false, readOnly = false),
      classifySQL(driver, "UPDATE notes SET body = 'not RETURNING syntax' WHERE body = 'alpha'"),
    )

    val result =
      driver.executeSQL(
        dbFile.absolutePath,
        "UPDATE notes SET body = 'not RETURNING syntax' WHERE body = 'alpha'",
      )

    assertEquals(SQLExecutionResult.Mutation(rowsAffected = 1), result)
    driver.closeAll()
  }

  @Test
  fun `ddl statements with inner select are not classified as read only queries`() {
    val driver = SQLiteDatabaseDriver(context)

    listOf(
        "CREATE TABLE backup AS SELECT * FROM notes",
        "CREATE VIEW notes_view AS SELECT * FROM notes",
      )
      .forEach { query ->
        assertEquals(
          Classification(returnsRows = false, readOnly = false),
          classifySQL(driver, query),
          query,
        )
      }
  }

  private fun createDatabase(name: String): File {
    val dbFile = context.getDatabasePath(name)
    dbFile.parentFile?.mkdirs()
    dbFile.delete()
    filesToDelete.add(dbFile)

    SQLiteDatabase.openOrCreateDatabase(dbFile, null).use { db ->
      db.execSQL("CREATE TABLE items (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)")
      db.execSQL("INSERT INTO items (id, value) VALUES (1, 0)")
    }

    return dbFile
  }

  private fun createNotesDatabase(name: String): File {
    val dbFile = context.getDatabasePath(name)
    dbFile.parentFile?.mkdirs()
    dbFile.delete()
    filesToDelete.add(dbFile)

    SQLiteDatabase.openOrCreateDatabase(dbFile, null).use { db ->
      db.execSQL("CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)")
      db.execSQL("INSERT INTO notes (body) VALUES ('alpha'), ('beta'), ('gamma')")
    }

    return dbFile
  }

  private fun classifySQL(driver: SQLiteDatabaseDriver, query: String): Classification {
    val classify =
      SQLiteDatabaseDriver::class.java.getDeclaredMethod("classifySQL", String::class.java).apply {
        isAccessible = true
      }
    val result = classify.invoke(driver, query) as Pair<*, *>
    return Classification(
      returnsRows = result.first as Boolean,
      readOnly = result.second as Boolean,
    )
  }

  private data class Classification(val returnsRows: Boolean, val readOnly: Boolean)
}
