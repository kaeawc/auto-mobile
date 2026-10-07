package dev.jasonpearson.automobile.sdk.storage

import android.content.ContextWrapper
import android.content.SharedPreferences
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

/**
 * Pins that setValue, removeValue and clear confirm the write reached disk before they return, and
 * report a failed write instead of replying success (#10168). `apply()` queues the disk write and
 * returns nothing, so a process kill right after the reply loses it and a failed write is
 * invisible.
 */
@RunWith(RobolectricTestRunner::class)
class SharedPreferencesDriverWriteDurabilityTest {
  private val fileName = "durable_prefs"
  private lateinit var prefs: RecordingSharedPreferences

  @Before
  fun setUp() {
    prefs = RecordingSharedPreferences(mapOf("existing" to "old"))
  }

  private fun driver(isMainThread: () -> Boolean = { false }): SharedPreferencesDriverImpl {
    val base = RuntimeEnvironment.getApplication()
    val context =
      object : ContextWrapper(base) {
        override fun getSharedPreferences(name: String?, mode: Int): SharedPreferences = prefs
      }
    val files = FakeFileSystemOperations()
    files.setFileExists(
      File(base.applicationInfo.dataDir, "shared_prefs/$fileName.xml").absolutePath,
      true,
    )
    return SharedPreferencesDriverImpl(context, files, isMainThread)
  }

  private val mutations: Map<String, (SharedPreferencesDriverImpl) -> Unit> =
    mapOf(
      "setValue" to { d -> d.setValue(fileName, "flag", true, KeyValueType.BOOLEAN) },
      "removeValue" to { d -> d.removeValue(fileName, "existing") },
      "clear" to { d -> d.clear(fileName) },
    )

  @Test
  fun `each mutation commits and never queues an apply`() {
    mutations.forEach { (name, mutate) ->
      prefs.writeCalls.clear()

      mutate(driver())

      assertEquals(listOf("commit"), prefs.writeCalls.map { it.method }, name)
    }
  }

  @Test
  fun `each mutation reports a failed disk write`() {
    prefs.commitResult = false
    mutations.forEach { (name, mutate) ->
      val error = assertFailsWith<SharedPreferencesError.WriteFailed>(name) { mutate(driver()) }

      assertTrue(error.message.orEmpty().contains(fileName), name)
    }
  }

  @Test
  fun `a failed write is a SharedPreferencesError so the provider replies with a failure`() {
    prefs.commitResult = false

    assertFailsWith<SharedPreferencesError> {
      driver().setValue(fileName, "flag", true, KeyValueType.BOOLEAN)
    }
  }

  @Test
  fun `a read immediately after a successful write observes it`() {
    val driver = driver()

    driver.setValue(fileName, "flag", true, KeyValueType.BOOLEAN)
    assertEquals(true, driver.getPreference(fileName, "flag")?.value)

    driver.removeValue(fileName, "existing")
    assertNull(driver.getPreference(fileName, "existing"))

    driver.clear(fileName)
    assertEquals(emptyList(), driver.getPreferences(fileName))
  }

  @Test
  fun `the apps own preference listener still fires once per changed key`() {
    val notified = mutableListOf<String?>()
    prefs.registerOnSharedPreferenceChangeListener { _, key -> notified.add(key) }

    driver().setValue(fileName, "flag", true, KeyValueType.BOOLEAN)

    assertEquals(listOf<String?>("flag"), notified)
  }

  @Test
  fun `the blocking commit runs on the calling binder thread`() {
    val worker = Thread({ driver().clear(fileName) }, "binder-1")

    worker.start()
    worker.join()
    val writeThread = prefs.writeCalls.single().threadName

    assertEquals("binder-1", writeThread)
    assertNotEquals(Thread.currentThread().name, writeThread)
  }

  @Test
  fun `on the main thread the write stays non-blocking`() {
    mutations.forEach { (name, mutate) ->
      prefs.writeCalls.clear()

      mutate(driver(isMainThread = { true }))

      assertEquals(listOf("apply"), prefs.writeCalls.map { it.method }, name)
    }
  }
}
