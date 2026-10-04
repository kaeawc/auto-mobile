package dev.jasonpearson.automobile.sdk.database

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.system.StructStat
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertSame
import kotlin.test.assertTrue
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.SQLiteMode
import org.robolectric.shadows.ShadowLinux

@RunWith(RobolectricTestRunner::class)
class SQLiteDatabaseDriverTest {

  private lateinit var context: Context
  private val filesToDelete = mutableListOf<File>()

  @Before
  fun setup() {
    context = RuntimeEnvironment.getApplication()
    // Load native SQLite in setup rather than charging shared-library startup to the first test.
    SQLiteDatabase.create(null).close()
  }

  @After
  fun tearDown() {
    filesToDelete.forEach { it.delete() }
  }

  @Test
  @Config(sdk = [29, 30], shadows = [DatabaseFileStatShadow::class])
  @SQLiteMode(SQLiteMode.Mode.NATIVE)
  fun `cached inspector reads recreated database rather than the deleted file`() {
    val file = createDatabase("cached-replacement.db")
    val driver = SQLiteDatabaseDriver(context)
    val fresh = SQLiteDatabaseDriver(context)
    try {
      assertEquals(listOf(listOf(1L, 0L)), driver.getTableData(file.path, "items", 10, 0).rows)
      val oldHandle = cachedHandle(driver, file.path)
      val oldIdentity = Os.stat(file.path)
      assertTrue(oldIdentity.st_ino != 0L, "stat must expose a real inode")
      assertTrue(context.deleteDatabase(file.name))
      createDatabase(file.name)
      context.openOrCreateDatabase(file.name, Context.MODE_PRIVATE, null).use { db ->
        db.execSQL("UPDATE items SET value = 1")
      }
      val newIdentity = Os.stat(file.path)
      assertNotEquals(
        oldIdentity.st_dev to oldIdentity.st_ino,
        newIdentity.st_dev to newIdentity.st_ino,
      )
      assertEquals(listOf(listOf(1L, 1L)), fresh.getTableData(file.path, "items", 10, 0).rows)
      assertEquals(listOf(listOf(1L, 1L)), driver.getTableData(file.path, "items", 10, 0).rows)
      assertFalse(oldHandle.isOpen)
    } finally {
      driver.closeAll()
      fresh.closeAll()
      context.deleteDatabase(file.name)
    }
  }

  @Test
  @Config(sdk = [29, 30], shadows = [DatabaseFileStatShadow::class])
  @SQLiteMode(SQLiteMode.Mode.NATIVE)
  fun `cached inspector reports not found after database is deleted`() {
    val file = createDatabase("cached-deleted.db")
    val driver = SQLiteDatabaseDriver(context)
    try {
      driver.getTableData(file.path, "items", 10, 0)
      val oldHandle = cachedHandle(driver, file.path)
      assertTrue(context.deleteDatabase(file.name))
      assertFailsWith<DatabaseError.NotFound> {
        driver.getTableData(file.path, "items", 10, 0)
      }
      assertFalse(oldHandle.isOpen)
    } finally {
      driver.closeAll()
      context.deleteDatabase(file.name)
    }
  }

  @Test
  @Config(sdk = [29, 30], shadows = [DatabaseFileStatShadow::class])
  @SQLiteMode(SQLiteMode.Mode.NATIVE)
  fun `unchanged database reuses its cached handle even when rows change`() {
    val file = createDatabase("cached-unchanged.db")
    val driver = SQLiteDatabaseDriver(context)
    try {
      driver.getTableData(file.path, "items", 10, 0)
      val handle = cachedHandle(driver, file.path)
      context.openOrCreateDatabase(file.name, Context.MODE_PRIVATE, null).use { db ->
        db.execSQL("UPDATE items SET value = 1")
      }
      assertEquals(listOf(listOf(1L, 1L)), driver.getTableData(file.path, "items", 10, 0).rows)
      assertSame(handle, cachedHandle(driver, file.path))
      assertTrue(handle.isOpen)
    } finally {
      driver.closeAll()
      context.deleteDatabase(file.name)
    }
  }

  @Test
  @Config(sdk = [29, 30], shadows = [DatabaseFileStatShadow::class])
  @SQLiteMode(SQLiteMode.Mode.NATIVE)
  fun `replacing one database preserves the other cached handle`() {
    val replaced = createDatabase("cached-independent-replaced.db")
    val unchanged = createDatabase("cached-independent-unchanged.db")
    val driver = SQLiteDatabaseDriver(context)
    try {
      driver.getTableData(replaced.path, "items", 10, 0)
      driver.getTableData(unchanged.path, "items", 10, 0)
      val oldHandle = cachedHandle(driver, replaced.path)
      val unchangedHandle = cachedHandle(driver, unchanged.path)
      assertTrue(context.deleteDatabase(replaced.name))
      createDatabase(replaced.name)
      context.openOrCreateDatabase(replaced.name, Context.MODE_PRIVATE, null).use { db ->
        db.execSQL("UPDATE items SET value = 1")
      }
      assertEquals(listOf(listOf(1L, 1L)), driver.getTableData(replaced.path, "items", 10, 0).rows)
      assertFalse(oldHandle.isOpen)
      assertTrue(unchangedHandle.isOpen)
      assertEquals(listOf(listOf(1L, 0L)), driver.getTableData(unchanged.path, "items", 10, 0).rows)
      assertSame(unchangedHandle, cachedHandle(driver, unchanged.path))
    } finally {
      driver.closeAll()
      context.deleteDatabase(replaced.name)
      context.deleteDatabase(unchanged.name)
    }
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

  @Test
  fun `multiple mutations are rejected before either table changes`() {
    val dbFile = createNotesDatabase("multiple-mutations.db")
    val driver = SQLiteDatabaseDriver(context)
    try {
      driver.executeSQL(dbFile.absolutePath, "CREATE TABLE backup AS SELECT * FROM notes")

      val error =
        assertFailsWith<DatabaseError.SqlError> {
          driver.executeSQL(dbFile.absolutePath, "DELETE FROM notes; DELETE FROM backup")
        }

      assertEquals("SQL error: Multiple SQL statements are not supported", error.message)
      assertEquals(3, driver.getTableData(dbFile.absolutePath, "notes", 10, 0).total)
      assertEquals(3, driver.getTableData(dbFile.absolutePath, "backup", 10, 0).total)
    } finally {
      driver.closeAll()
    }
  }

  @Test
  fun `select followed by mutation is rejected on both execution paths`() {
    val dbFile = createNotesDatabase("multiple-read-statements.db")
    val driver = SQLiteDatabaseDriver(context)
    try {
      val query = "SELECT 1; DELETE FROM notes"
      val writableError =
        assertFailsWith<DatabaseError.SqlError> {
          driver.executeSQL(dbFile.absolutePath, query)
        }
      val readOnlyError =
        assertFailsWith<DatabaseError.SqlError> {
          driver.executeReadOnlySQL(dbFile.absolutePath, query)
        }
      val mutationError =
        assertFailsWith<DatabaseError.SqlError> {
          driver.executeReadOnlySQL(dbFile.absolutePath, "DELETE FROM notes; DELETE FROM notes")
        }

      listOf(writableError, readOnlyError, mutationError).forEach { error ->
        assertEquals("SQL error: Multiple SQL statements are not supported", error.message)
      }
      assertEquals(3, driver.getTableData(dbFile.absolutePath, "notes", 10, 0).total)
    } finally {
      driver.closeAll()
    }
  }

  @Test
  fun `trailing terminators and comments preserve single statement execution`() {
    val dbFile = createNotesDatabase("trailing-sql-trivia.db")
    val driver = SQLiteDatabaseDriver(context)
    try {
      listOf(";", ";  ", "; -- trailing ; comment", "; /* trailing ; comment */ ").forEach { suffix
        ->
        val query = "SELECT body FROM notes WHERE id = 1$suffix"
        assertEquals(
          listOf(listOf("alpha")),
          (driver.executeSQL(dbFile.absolutePath, query) as SQLExecutionResult.Query).rows,
        )
        assertEquals(
          listOf(listOf("alpha")),
          driver.executeReadOnlySQL(dbFile.absolutePath, query).rows,
        )
        assertEquals(
          SQLExecutionResult.Mutation(rowsAffected = 1),
          driver.executeSQL(
            dbFile.absolutePath,
            "UPDATE notes SET body = body WHERE id = 1$suffix",
          ),
        )
      }
    } finally {
      driver.closeAll()
    }
  }

  @Test
  fun `quoted and commented semicolons are not statement boundaries`() {
    val dbFile = createNotesDatabase("quoted-sql-semicolons.db")
    val driver = SQLiteDatabaseDriver(context)
    try {
      listOf(
          "SELECT 'a;b' AS value",
          "SELECT 'a'';b' AS value",
          "SELECT 1 AS \"a;b\"",
          "SELECT 1 AS \"a\"\";b\"",
          "SELECT 1 AS `a;b`",
          "SELECT 1 AS `a``;b`",
          "SELECT 1 AS [a;b]",
          "SELECT -- ; DELETE FROM notes\n 1 AS value",
          "SELECT -- comment\r; DELETE FROM notes\n 1 AS value",
          "SELECT /* ; DELETE FROM notes */ 1 AS value",
          "SELECT \$value(a;b)",
          "SELECT \$namespace::value(a(b)",
        )
        .forEach { query ->
          val result = driver.executeSQL(dbFile.absolutePath, query) as SQLExecutionResult.Query
          assertEquals(1, result.rows.size, query)
          assertEquals(
            result.rows,
            driver.executeReadOnlySQL(dbFile.absolutePath, query).rows,
            query,
          )
        }
      assertEquals(
        SQLExecutionResult.Mutation(rowsAffected = 1),
        driver.executeSQL(dbFile.absolutePath, "UPDATE notes SET body = 'a;b' WHERE id = 1"),
      )
      assertEquals("a;b", driver.getTableData(dbFile.absolutePath, "notes", 10, 0).rows[0][1])
    } finally {
      driver.closeAll()
    }
  }

  @Test
  fun `trigger body semicolons and nested case ends stay within one statement`() {
    val dbFile = createNotesDatabase("trigger-statements.db")
    val driver = SQLiteDatabaseDriver(context)
    try {
      driver.executeSQL(dbFile.absolutePath, "CREATE TABLE audit (body TEXT NOT NULL)")
      listOf("", "TEMP ", "TEMPORARY ").forEachIndexed { index, modifier ->
        driver.executeSQL(dbFile.absolutePath, auditTrigger("audit_$index", modifier))
      }
      driver.executeSQL(dbFile.absolutePath, "INSERT INTO notes (body) VALUES ('delta')")

      val audit = driver.getTableData(dbFile.absolutePath, "audit", 20, 0)
      assertEquals(6, audit.total)
      assertEquals(3, audit.rows.count { it == listOf("first;body") })
      assertEquals(3, audit.rows.count { it == listOf("delta") })
    } finally {
      driver.closeAll()
    }
  }

  @Test
  fun `trigger followed by another statement is rejected without creating the trigger`() {
    val dbFile = createNotesDatabase("trigger-with-tail.db")
    val driver = SQLiteDatabaseDriver(context)
    try {
      driver.executeSQL(dbFile.absolutePath, "CREATE TABLE audit (body TEXT NOT NULL)")
      val error =
        assertFailsWith<DatabaseError.SqlError> {
          driver.executeSQL(
            dbFile.absolutePath,
            auditTrigger("blocked_trigger") + " /* tail */ DELETE FROM notes",
          )
        }
      assertEquals("SQL error: Multiple SQL statements are not supported", error.message)
      driver.executeSQL(dbFile.absolutePath, "INSERT INTO notes (body) VALUES ('delta')")
      assertEquals(0, driver.getTableData(dbFile.absolutePath, "audit", 10, 0).total)
      assertEquals(4, driver.getTableData(dbFile.absolutePath, "notes", 10, 0).total)
    } finally {
      driver.closeAll()
    }
  }

  @Test
  fun `standalone transaction control does not hide later statements`() {
    val dbFile = createNotesDatabase("transaction-with-tail.db")
    val driver = SQLiteDatabaseDriver(context)
    try {
      listOf(
          "BEGIN; DELETE FROM notes; COMMIT",
          "COMMIT; DELETE FROM notes",
          "END; DELETE FROM notes",
          "DELETE FROM notes; 'unterminated",
          "SELECT \$namespace::value(a(b); DELETE FROM notes",
          "DELETE FROM notes; (unterminated",
        )
        .forEach { query ->
          val error =
            assertFailsWith<DatabaseError.SqlError> {
              driver.executeSQL(dbFile.absolutePath, query)
            }
          assertEquals("SQL error: Multiple SQL statements are not supported", error.message)
        }
      assertEquals(3, driver.getTableData(dbFile.absolutePath, "notes", 10, 0).total)
    } finally {
      driver.closeAll()
    }
  }

  private fun auditTrigger(name: String, modifier: String = ""): String =
    """
    CREATE ${modifier}TRIGGER $name AFTER INSERT ON notes BEGIN
      INSERT INTO audit (body) VALUES ('first;body');
      INSERT INTO audit (body) VALUES (
        CASE WHEN NEW.body = 'delta' THEN
          CASE WHEN NEW.id > 0 THEN NEW.body ELSE 'inner fallback' END
        ELSE 'outer fallback' END
      );
    END;
    """
      .trimIndent()

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

  // Inspect only after synchronous driver calls; no production API or unlocked open call is needed.
  private fun cachedHandle(driver: SQLiteDatabaseDriver, path: String): SQLiteDatabase {
    val cacheField = SQLiteDatabaseDriver::class.java.getDeclaredField("openDatabases")
    cacheField.isAccessible = true
    val cache = cacheField.get(driver)
    check(cache is Map<*, *>) {
      "openDatabases must be a Map, got ${cache?.javaClass?.name ?: "null"}"
    }
    val entry = checkNotNull(cache[path]) { "No cached database for $path" }
    // Also supports the original bare-handle cache when running the pre-fix regression tests.
    if (entry is SQLiteDatabase) return entry
    val databaseField = entry.javaClass.getDeclaredField("database")
    databaseField.isAccessible = true
    val database = databaseField.get(entry)
    check(database is SQLiteDatabase) {
      "Cached database for $path must be a SQLiteDatabase, got ${database?.javaClass?.name ?: "null"}"
    }
    return database
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
    val result = classify.invoke(driver, query)
    check(result is Pair<*, *>) {
      "classifySQL must return a Pair, got ${result?.javaClass?.name ?: "null"}"
    }
    val returnsRows = result.first
    val readOnly = result.second
    check(returnsRows is Boolean) {
      "classifySQL returnsRows must be a Boolean, got ${returnsRows?.javaClass?.name ?: "null"}"
    }
    check(readOnly is Boolean) {
      "classifySQL readOnly must be a Boolean, got ${readOnly?.javaClass?.name ?: "null"}"
    }
    return Classification(returnsRows = returnsRows, readOnly = readOnly)
  }

  private data class Classification(val returnsRows: Boolean, val readOnly: Boolean)
}

// Robolectric 4.17's ShadowLinux.stat hardcodes st_dev and st_ino to zero, even with native SQLite.
// Supply real host identities only in the replacement tests; production uses API-21 Os.stat.
@Implements(className = "libcore.io.Linux", minSdk = 26, isInAndroidSdk = false)
class DatabaseFileStatShadow : ShadowLinux() {
  companion object {
    // Robolectric supports static implementations of instance methods. Avoid a receiver cast to
    // this test shadow if a Linux instance already carries a base ShadowLinux in the sandbox.
    @JvmStatic
    @Implementation(methodName = "stat")
    fun statWithFileIdentity(path: String?): StructStat {
      // ShadowLinux.fstat delegates with a null path; retain its default behavior for that case.
      if (path == null) return ShadowLinux().stat(null)
      val attributes =
        try {
          Files.readAttributes(File(path).toPath(), "unix:dev,ino")
        } catch (error: IOException) {
          throw ErrnoException("stat", OsConstants.ENOENT, error)
        }
      val original = ShadowLinux().stat(path)
      return StructStat(
        numericAttribute(attributes, "dev", path),
        numericAttribute(attributes, "ino", path),
        original.st_mode,
        original.st_nlink,
        original.st_uid,
        original.st_gid,
        original.st_rdev,
        original.st_size,
        original.st_atime,
        original.st_mtime,
        original.st_ctime,
        original.st_blksize,
        original.st_blocks,
      )
    }

    private fun numericAttribute(attributes: Map<String, *>, name: String, path: String): Long {
      val value = attributes[name]
      check(value is Number) {
        "unix:$name for $path must be a Number, got ${value?.javaClass?.name ?: "null (missing or null attribute)"}"
      }
      return value.toLong()
    }
  }
}
