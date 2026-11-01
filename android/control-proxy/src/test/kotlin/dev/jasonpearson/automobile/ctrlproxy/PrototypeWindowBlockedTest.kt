package dev.jasonpearson.automobile.ctrlproxy

import android.app.KeyguardManager
import android.content.Context
import android.os.PowerManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class PrototypeWindowBlockedTest {
  @Test
  fun `only an unlocked, interactive device may show a prototype window`() {
    val cases =
      listOf(
        Triple(false, true, false),
        Triple(true, true, true),
        Triple(false, false, true),
        Triple(true, false, true),
      )
    for ((locked, interactive, blocked) in cases) {
      assertEquals(
        "locked=$locked interactive=$interactive",
        blocked,
        prototypeWindowBlocked(keyguardLocked = locked, interactive = interactive),
      )
    }
  }

  @Test
  fun `an unreadable lock or screen state counts as blocked`() {
    assertEquals(true, prototypeWindowBlocked(keyguardLocked = null, interactive = true))
    assertEquals(true, prototypeWindowBlocked(keyguardLocked = false, interactive = null))
    assertEquals(true, prototypeWindowBlocked(keyguardLocked = null, interactive = null))
  }

  @Test
  fun `the service reads the device's keyguard and power state`() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val keyguard = shadowOf(context.getSystemService(KeyguardManager::class.java))
    val power = shadowOf(context.getSystemService(PowerManager::class.java))

    keyguard.setKeyguardLocked(false)
    power.setIsInteractive(true)
    assertEquals(false, context.prototypeWindowBlocked())

    keyguard.setKeyguardLocked(true)
    assertEquals(true, context.prototypeWindowBlocked())

    keyguard.setKeyguardLocked(false)
    power.setIsInteractive(false)
    assertEquals(true, context.prototypeWindowBlocked())
  }
}
