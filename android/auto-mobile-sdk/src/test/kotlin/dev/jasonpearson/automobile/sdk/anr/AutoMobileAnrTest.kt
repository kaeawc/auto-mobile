package dev.jasonpearson.automobile.sdk.anr

import android.os.Build
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * Unit tests for [AutoMobileAnr] availability gating and safe initialization. ANR detection is
 * documented (and chipped "🧪 Tested") as retrospective and available only on Android 11+ (API 30)
 * via `ApplicationExitInfo`; pin that SDK-version boundary and that initialize is safe with no
 * historical ANRs.
 */
@RunWith(RobolectricTestRunner::class)
class AutoMobileAnrTest {

  private val context: android.content.Context = RuntimeEnvironment.getApplication()

  @Test
  @Config(sdk = [Build.VERSION_CODES.R])
  fun `isAvailable is true on API 30 and above`() {
    assertTrue(AutoMobileAnr.isAvailable())
  }

  @Test
  @Config(sdk = [Build.VERSION_CODES.Q])
  fun `isAvailable is false below API 30`() {
    assertFalse(AutoMobileAnr.isAvailable())
  }

  @Test
  @Config(sdk = [Build.VERSION_CODES.Q])
  fun `initialize is a safe no-op below API 30`() {
    // Must not throw on a device where ApplicationExitInfo is unavailable.
    AutoMobileAnr.initialize(context)
  }

  @Test
  @Config(sdk = [Build.VERSION_CODES.R])
  fun `initialize on API 30 with no historical ANRs completes without error`() {
    // Robolectric reports no historical process exit reasons by default, so the
    // retrospective scan should find nothing and broadcast nothing.
    AutoMobileAnr.initialize(context)
    assertTrue(AutoMobileAnr.isAvailable())
  }
}
