package dev.jasonpearson.automobile.sdk.events

import android.content.pm.PackageManager
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.BeforeClass
import org.junit.Test

class SdkEventAckCapabilityTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmUpGate() {
      SdkEventAckCapability(AckPackageInfoReader { false }, { 0 }).isSupported()
    }
  }

  private class FakeReader : AckPackageInfoReader {
    var supported = false
    var failure: Exception? = null
    var reads = 0

    override fun supportsAcknowledgment(): Boolean {
      reads++
      failure?.let { throw it }
      return supported
    }
  }

  @Test
  fun `cache refreshes false and true capabilities at bounded interval`() {
    var now = 0L
    val reader = FakeReader()
    val gate = SdkEventAckCapability(reader, { now }, refreshIntervalMs = 30)
    assertFalse(gate.isSupported())
    reader.supported = true
    now = 29
    assertFalse(gate.isSupported())
    assertEquals(1, reader.reads)
    now = 30
    assertTrue(gate.isSupported())
    reader.supported = false
    now = 59
    assertTrue(gate.isSupported())
    now = 60
    assertFalse(gate.isSupported())
    assertEquals(3, reader.reads)
  }

  @Test
  fun `missing or invisible package is retried on next send`() {
    val reader = FakeReader().apply { failure = PackageManager.NameNotFoundException("hidden") }
    val gate = SdkEventAckCapability(reader, { 0 })
    assertFalse(gate.isSupported())
    reader.failure = null
    reader.supported = true
    assertTrue(gate.isSupported())
    assertEquals(2, reader.reads)
  }

  @Test
  fun `unreadable metadata stays off until interval expires`() {
    var now = 0L
    val reader = FakeReader().apply { failure = SecurityException("denied") }
    val gate = SdkEventAckCapability(reader, { now }, 30)
    assertFalse(gate.isSupported())
    reader.failure = null
    reader.supported = true
    assertFalse(gate.isSupported())
    now = 30
    assertTrue(gate.isSupported())
  }
}
