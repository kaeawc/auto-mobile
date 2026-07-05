package dev.jasonpearson.automobile.sdk.storage

import android.content.Context
import kotlin.test.assertEquals
import kotlin.test.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

/**
 * Verifies that [SharedPreferencesDriverImpl] captures the value that was present BEFORE a change
 * and reports it as [PreferenceChange.previousValue] (#3000). The SharedPreferences change listener
 * fires only after the write is committed, so the driver must derive the prior value from a
 * per-file snapshot it maintains — these tests pin that behavior across add / modify / remove /
 * re-listen.
 */
@RunWith(RobolectricTestRunner::class)
class SharedPreferencesPreviousValueTest {

  private lateinit var context: Context
  private val fileName = "prefs_prev_value"

  @Before
  fun setup() {
    context = RuntimeEnvironment.getApplication()
    // Start each test from a clean file so seeded snapshots are deterministic.
    context.getSharedPreferences(fileName, Context.MODE_PRIVATE).edit().clear().commit()
  }

  private fun latestChangeFor(driver: SharedPreferencesDriverImpl, key: String): PreferenceChange? =
    driver.getQueuedChanges(fileName, 0L).lastOrNull { it.key == key }

  @Test
  fun `newly added key has null previous value`() {
    val driver = SharedPreferencesDriverImpl(context)
    driver.startListening(fileName)

    context
      .getSharedPreferences(fileName, Context.MODE_PRIVATE)
      .edit()
      .putString("k", "v1")
      .commit()

    val change = latestChangeFor(driver, "k")
    assertEquals("v1", change?.newValue)
    assertNull(change?.previousValue, "A newly added key must report no prior value")
  }

  @Test
  fun `modifying an existing key reports the prior value`() {
    // Seed a value BEFORE listening so the snapshot is primed from disk.
    context
      .getSharedPreferences(fileName, Context.MODE_PRIVATE)
      .edit()
      .putString("k", "old")
      .commit()

    val driver = SharedPreferencesDriverImpl(context)
    driver.startListening(fileName)

    context
      .getSharedPreferences(fileName, Context.MODE_PRIVATE)
      .edit()
      .putString("k", "new")
      .commit()

    val change = latestChangeFor(driver, "k")
    assertEquals("new", change?.newValue)
    assertEquals("old", change?.previousValue)
  }

  @Test
  fun `successive modifications each report the immediately prior value`() {
    context.getSharedPreferences(fileName, Context.MODE_PRIVATE).edit().putInt("count", 1).commit()

    val driver = SharedPreferencesDriverImpl(context)
    driver.startListening(fileName)

    val prefs = context.getSharedPreferences(fileName, Context.MODE_PRIVATE)
    prefs.edit().putInt("count", 2).commit()
    prefs.edit().putInt("count", 3).commit()

    val changes = driver.getQueuedChanges(fileName, 0L).filter { it.key == "count" }
    assertEquals(2, changes.size)
    assertEquals(1, changes[0].previousValue)
    assertEquals(2, changes[0].newValue)
    assertEquals(2, changes[1].previousValue)
    assertEquals(3, changes[1].newValue)
  }

  @Test
  fun `removing a key reports the prior value and a null new value`() {
    context
      .getSharedPreferences(fileName, Context.MODE_PRIVATE)
      .edit()
      .putString("k", "present")
      .commit()

    val driver = SharedPreferencesDriverImpl(context)
    driver.startListening(fileName)

    context.getSharedPreferences(fileName, Context.MODE_PRIVATE).edit().remove("k").commit()

    val change = latestChangeFor(driver, "k")
    assertNull(change?.newValue)
    assertEquals("present", change?.previousValue)
    // The new value is null (type UNKNOWN), but the prior value keeps its own STRING
    // type so downstream serialization/quoting stays correct (#3000).
    assertEquals(KeyValueType.UNKNOWN, change?.type)
    assertEquals(KeyValueType.STRING, change?.previousValueType)
  }

  @Test
  fun `stopListening then relistening reseeds the snapshot from disk`() {
    context
      .getSharedPreferences(fileName, Context.MODE_PRIVATE)
      .edit()
      .putString("k", "v1")
      .commit()

    val driver = SharedPreferencesDriverImpl(context)
    driver.startListening(fileName)
    context
      .getSharedPreferences(fileName, Context.MODE_PRIVATE)
      .edit()
      .putString("k", "v2")
      .commit()
    driver.stopListening(fileName)

    // A fresh listener must re-seed from the on-disk state (v2), not carry stale data.
    driver.startListening(fileName)
    context
      .getSharedPreferences(fileName, Context.MODE_PRIVATE)
      .edit()
      .putString("k", "v3")
      .commit()

    val change = latestChangeFor(driver, "k")
    assertEquals("v3", change?.newValue)
    assertEquals("v2", change?.previousValue)
  }
}
