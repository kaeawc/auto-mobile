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
import org.robolectric.RuntimeEnvironment
import org.robolectric.RobolectricTestRunner

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

    val error =
        kotlin.runCatching { driver.executeSQL(siblingPath, "SELECT 1") }.exceptionOrNull()

    assertTrue(error is DatabaseError.InvalidPath)
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
            driver.executeSQL(dbFile.absolutePath, "UPDATE items SET value = value + 1 WHERE id = 1")
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
}
