package dev.jasonpearson.automobile.sdk.anr

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.os.Build
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowActivityManager.ApplicationExitInfoBuilder

/**
 * Unit tests for [AutoMobileAnr] availability gating and safe initialization. ANR detection is
 * documented (and chipped "🧪 Tested") as retrospective and available only on Android 11+ (API 30)
 * via `ApplicationExitInfo`; pin that SDK-version boundary and that initialize is safe with no
 * historical ANRs.
 */
@RunWith(RobolectricTestRunner::class)
class AutoMobileAnrTest {

  private val context: android.content.Context = RuntimeEnvironment.getApplication()

  @After
  fun tearDown() {
    AutoMobileAnr.reset()
  }

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

  // Deterministic Robolectric end-to-end tests: supported exit-info builder, no reflection.
  @Test
  @Config(sdk = [Build.VERSION_CODES.R])
  fun `failed ANR broadcast preserves stored watermark for the next launch`() {
    addAnr(timestamp = 20L)
    context
      .getSharedPreferences("automobile_anr_prefs", Context.MODE_PRIVATE)
      .edit()
      .putLong("last_reported_anr_timestamp", 10L)
      .commit()
    val failingContext = BroadcastContext(context, fail = true)

    AutoMobileAnr.initialize(failingContext)

    assertEquals(1, failingContext.attempts)
    assertTrue(failingContext.broadcasts.isEmpty())
    assertEquals(10L, storedTimestamp())
  }

  @Test
  @Config(sdk = [Build.VERSION_CODES.R])
  fun `successful ANR broadcast advances stored watermark`() {
    addAnr(timestamp = 20L)
    val recordingContext = BroadcastContext(context)

    AutoMobileAnr.initialize(recordingContext)

    assertEquals(1, recordingContext.attempts)
    assertEquals(AutoMobileAnr.ACTION_ANR, recordingContext.broadcasts.single().action)
    assertEquals(20L, storedTimestamp())
  }

  private fun addAnr(timestamp: Long) {
    val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val exitInfo =
      ApplicationExitInfoBuilder.newBuilder()
        .setReason(ApplicationExitInfo.REASON_ANR)
        .setTimestamp(timestamp)
        .setPid(123)
        .setProcessName(context.packageName)
        .build()
    shadowOf(activityManager).addApplicationExitInfo(exitInfo)
  }

  private fun storedTimestamp(): Long =
    context
      .getSharedPreferences("automobile_anr_prefs", Context.MODE_PRIVATE)
      .getLong("last_reported_anr_timestamp", 0L)

  private class BroadcastContext(base: Context, private val fail: Boolean = false) :
    ContextWrapper(base) {
    val broadcasts = mutableListOf<Intent>()
    var attempts = 0
      private set

    override fun getApplicationContext(): Context = this

    override fun sendBroadcast(intent: Intent) {
      attempts++
      if (fail) throw IllegalStateException("Test broadcast failure")
      broadcasts.add(intent)
    }
  }
}
