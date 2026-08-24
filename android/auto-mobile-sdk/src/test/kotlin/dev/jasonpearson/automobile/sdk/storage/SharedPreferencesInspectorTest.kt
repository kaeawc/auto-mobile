package dev.jasonpearson.automobile.sdk.storage

import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class SharedPreferencesInspectorTest {
  private val fakeDriver =
    object : SharedPreferencesDriver {
      override fun getPreferenceFiles() = emptyList<PreferenceFileDescriptor>()

      override fun getPreferences(fileName: String) = emptyList<KeyValuePair>()

      override fun registerOnChangeListener(listener: OnPreferenceChangeListener) = Unit

      override fun unregisterOnChangeListener(listener: OnPreferenceChangeListener) = Unit

      override fun getPreference(fileName: String, key: String) = null

      override fun setValue(fileName: String, key: String, value: Any?, type: KeyValueType) = Unit

      override fun removeValue(fileName: String, key: String) = Unit

      override fun clear(fileName: String) = Unit
    }

  @Before
  fun setUp() {
    SharedPreferencesInspector.reset()
  }

  @Test
  fun `isEnabled returns false by default`() {
    assertFalse(SharedPreferencesInspector.isEnabled())
  }

  @Test
  fun `setEnabled updates enabled state`() {
    SharedPreferencesInspector.setEnabled(true)

    assertTrue(SharedPreferencesInspector.isEnabled())

    SharedPreferencesInspector.setEnabled(false)

    assertFalse(SharedPreferencesInspector.isEnabled())
  }

  @Test
  fun `getDriver throws NotInitialized when not initialized`() {
    try {
      SharedPreferencesInspector.getDriver()
      fail("Expected SharedPreferencesError.NotInitialized")
    } catch (e: SharedPreferencesError.NotInitialized) {
      assertTrue(e.message!!.contains("not initialized"))
    }
  }

  @Test
  fun `reset clears state`() {
    SharedPreferencesInspector.setEnabled(true)

    SharedPreferencesInspector.reset()

    assertFalse(SharedPreferencesInspector.isEnabled())
  }

  @Test
  fun `registered driver names are removable`() {
    SharedPreferencesInspector.registerDriver("datastore", fakeDriver)

    assertEquals(setOf("datastore"), SharedPreferencesInspector.registeredDriverNames())
    assertTrue(SharedPreferencesInspector.unregisterDriver("datastore"))
    assertFalse(SharedPreferencesInspector.unregisterDriver("datastore"))
  }

  private fun newDriver() =
    object : SharedPreferencesDriver {
      override fun getPreferenceFiles() = emptyList<PreferenceFileDescriptor>()

      override fun getPreferences(fileName: String) = emptyList<KeyValuePair>()

      override fun registerOnChangeListener(listener: OnPreferenceChangeListener) = Unit

      override fun unregisterOnChangeListener(listener: OnPreferenceChangeListener) = Unit

      override fun getPreference(fileName: String, key: String) = null

      override fun setValue(fileName: String, key: String, value: Any?, type: KeyValueType) = Unit

      override fun removeValue(fileName: String, key: String) = Unit

      override fun clear(fileName: String) = Unit
    }

  // #5581 — a stale registration handle must not remove a replacement registered under the same
  // name.
  @Test
  fun `stale registration handle does not remove a replacement`() {
    val firstReg = SharedPreferencesInspector.registerDriver("prefs", newDriver())
    SharedPreferencesInspector.registerDriver("prefs", newDriver()) // replaces first

    assertFalse(firstReg.unregister())
    assertEquals(setOf("prefs"), SharedPreferencesInspector.registeredDriverNames())
  }

  // #5581 — a current registration handle removes only its own registration.
  @Test
  fun `current registration handle removes its driver`() {
    val reg = SharedPreferencesInspector.registerDriver("prefs", newDriver())

    assertTrue(reg.unregister())
    assertTrue(SharedPreferencesInspector.registeredDriverNames().isEmpty())
    assertFalse(reg.unregister())
  }

  @Test
  fun `unknown named driver does not fall back to default`() {
    try {
      SharedPreferencesInspector.getDriver("missing")
      fail("Expected SharedPreferencesError.DriverNotFound")
    } catch (error: SharedPreferencesError.DriverNotFound) {
      assertTrue(error.message!!.contains("missing"))
    }
  }
}
