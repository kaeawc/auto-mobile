package dev.jasonpearson.automobile.sdk.storage

import android.content.Context
import android.content.SharedPreferences
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertNull
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLooper

@RunWith(RobolectricTestRunner::class)
class SharedPreferencesClearSnapshotTest {
  private val fileName = "clear_snapshot"
  private lateinit var preferences: SharedPreferences
  private lateinit var driver: SharedPreferencesDriverImpl

  @Before
  fun setup() {
    val context = RuntimeEnvironment.getApplication()
    preferences = context.getSharedPreferences(fileName, Context.MODE_PRIVATE)
    preferences.edit().clear().commit()
    val files = FakeFileSystemOperations()
    files.setFileExists(
      File(context.applicationInfo.dataDir, "shared_prefs/$fileName.xml").absolutePath,
      true,
    )
    driver = SharedPreferencesDriverImpl(context, files)
  }

  @After
  fun tearDown() {
    driver.stopAllListening()
  }

  @Test
  @Config(sdk = [29])
  fun `API 29 clear emits no framework callback`() {
    preferences.edit().putString("k", "old").putInt("other", 1).commit()
    val keys = mutableListOf<String?>()
    val listener = SharedPreferences.OnSharedPreferenceChangeListener { _, key -> keys.add(key) }
    preferences.registerOnSharedPreferenceChangeListener(listener)
    try {
      preferences.edit().clear().commit()
      ShadowLooper.idleMainLooper()
      assertEquals(emptyList(), keys)
      assertEquals(emptyMap(), preferences.all)
    } finally {
      preferences.unregisterOnSharedPreferenceChangeListener(listener)
    }
  }

  @Test
  @Config(sdk = [30])
  fun `API 30 clear emits one null key rather than removed keys`() {
    preferences.edit().putString("k", "old").putInt("other", 1).commit()
    val keys = mutableListOf<String?>()
    val listener = SharedPreferences.OnSharedPreferenceChangeListener { _, key -> keys.add(key) }
    preferences.registerOnSharedPreferenceChangeListener(listener)
    try {
      preferences.edit().clear().commit()
      ShadowLooper.idleMainLooper()
      assertEquals(listOf<String?>(null), keys)
      assertEquals(emptyMap(), preferences.all)
    } finally {
      preferences.unregisterOnSharedPreferenceChangeListener(listener)
    }
  }

  @Test
  @Config(sdk = [29])
  fun `API 29 next unrelated event reconciles silently cleared keys`() {
    preferences.edit().putString("k", "old").commit()
    driver.startListening(fileName)
    preferences.edit().clear().commit()
    ShadowLooper.idleMainLooper()
    assertEquals(emptyList(), driver.getQueuedChanges(fileName, 0))

    preferences.edit().putString("unrelated", "event").commit()
    ShadowLooper.idleMainLooper()
    driver.getQueuedChanges(fileName, 0)
    preferences.edit().putString("k", "new").commit()
    ShadowLooper.idleMainLooper()

    val change = driver.getQueuedChanges(fileName, 0).single { it.key == "k" }
    assertEquals("new", change.newValue)
    assertNull(change.previousValue, "A silently cleared key has no previous value")
    assertEquals(KeyValueType.UNKNOWN, change.previousValueType)
  }

  @Test
  @Config(sdk = [30])
  fun `API 30 clear then immediately resetting the only key has no previous value`() {
    preferences.edit().putString("k", "old").commit()
    driver.startListening(fileName)
    preferences.edit().clear().commit()
    ShadowLooper.idleMainLooper()
    driver.getQueuedChanges(fileName, 0)
    preferences.edit().putString("k", "new").commit()
    ShadowLooper.idleMainLooper()

    val change = driver.getQueuedChanges(fileName, 0).single { it.key == "k" }
    assertEquals("new", change.newValue)
    assertNull(change.previousValue, "A re-added key has no previous value")
    assertEquals(KeyValueType.UNKNOWN, change.previousValueType)
  }

  @Test
  @Config(sdk = [29, 30])
  fun `stored Long is read and snapshotted by runtime type without truncation`() {
    val value = Int.MAX_VALUE.toLong() + 1
    preferences.edit().putLong("k", value).commit()
    assertEquals(KeyValuePair("k", value, KeyValueType.LONG), driver.getPreference(fileName, "k"))
    assertEquals(
      listOf(KeyValuePair("k", value, KeyValueType.LONG)),
      driver.getPreferences(fileName),
    )
    driver.startListening(fileName)
    preferences.edit().putInt("k", 7).commit()
    ShadowLooper.idleMainLooper()

    val change = driver.getQueuedChanges(fileName, 0).single()
    assertEquals(value, change.previousValue)
    assertEquals(KeyValueType.LONG, change.previousValueType)
    assertEquals(7, change.newValue)
    assertEquals(KeyValueType.INT, change.type)
  }

  @Test
  @Config(sdk = [29, 30])
  fun `single-key updates preserve previous values and other live snapshot keys`() {
    preferences.edit().putString("first", "old").putInt("second", 7).commit()
    driver.startListening(fileName)

    preferences.edit().putString("first", "new").commit()
    ShadowLooper.idleMainLooper()
    val firstChange = driver.getQueuedChanges(fileName, 0).single()
    assertEquals("first", firstChange.key)
    assertEquals("old", firstChange.previousValue)
    assertEquals(KeyValueType.STRING, firstChange.previousValueType)
    assertEquals("new", firstChange.newValue)
    assertEquals(KeyValueType.STRING, firstChange.type)

    preferences.edit().putInt("second", 8).commit()
    ShadowLooper.idleMainLooper()
    val secondChange = driver.getQueuedChanges(fileName, 0).single()
    assertEquals("second", secondChange.key)
    assertEquals(7, secondChange.previousValue)
    assertEquals(KeyValueType.INT, secondChange.previousValueType)
    assertEquals(8, secondChange.newValue)
    assertEquals(KeyValueType.INT, secondChange.type)
  }
}
