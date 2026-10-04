package dev.jasonpearson.automobile.sdk.anr

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.os.Build
import dev.jasonpearson.automobile.protocol.SdkAnrEvent
import dev.jasonpearson.automobile.protocol.SdkEventSerializer
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.logging.FakeSdkLogger
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
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
  private val originalLogger = AutoMobileSDK.logger
  private val logger = FakeSdkLogger()

  @Before
  fun setUp() {
    AutoMobileSDK.logger = logger
  }

  @After
  fun tearDown() {
    AutoMobileAnr.reset()
    AutoMobileSDK.logger = originalLogger
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

  @Test
  @Config(sdk = [Build.VERSION_CODES.R])
  fun `equal timestamp retry reports only the previously failed ANR`() {
    addAnr(timestamp = 20L, pid = 101)
    addAnr(timestamp = 20L, pid = 102)
    val firstLaunch = BroadcastContext(context, failOnAttempts = setOf(2))

    AutoMobileAnr.initialize(firstLaunch)

    assertEquals(2, firstLaunch.attempts)
    assertEquals(1, firstLaunch.events.size)
    assertEquals(20L, storedTimestamp())
    AutoMobileAnr.reset()
    val secondLaunch = BroadcastContext(context)

    AutoMobileAnr.initialize(secondLaunch)

    assertEquals(1, secondLaunch.attempts)
    assertEquals(firstLaunch.attemptedEvents[1].pid, secondLaunch.events.single().pid)
    assertEquals(
      listOf(101, 102),
      (firstLaunch.events + secondLaunch.events).map { it.pid }.sorted(),
    )
  }

  @Test
  @Config(sdk = [Build.VERSION_CODES.R])
  fun `three equal timestamp ANRs are each reported once across retries`() {
    for (pid in 101..103) addAnr(timestamp = 20L, pid = pid)
    val firstLaunch = BroadcastContext(context, failOnAttempts = setOf(2))
    AutoMobileAnr.initialize(firstLaunch)
    assertEquals(2, firstLaunch.attempts)
    AutoMobileAnr.reset()
    val secondLaunch = BroadcastContext(context, failOnAttempts = setOf(1))
    AutoMobileAnr.initialize(secondLaunch)
    assertEquals(1, secondLaunch.attempts)
    assertEquals(1, storedIds()?.size)
    AutoMobileAnr.reset()
    val thirdLaunch = BroadcastContext(context)
    AutoMobileAnr.initialize(thirdLaunch)

    assertEquals(2, thirdLaunch.attempts)
    assertTrue(secondLaunch.events.isEmpty())
    assertEquals(
      listOf(101, 102, 103),
      (firstLaunch.events + thirdLaunch.events).map { it.pid }.sorted(),
    )
    assertEquals(
      (firstLaunch.events + thirdLaunch.events).map { identity(it.pid, it.processName) }.toSet(),
      storedIds(),
    )
    AutoMobileAnr.reset()
    val fourthLaunch = BroadcastContext(context)
    AutoMobileAnr.initialize(fourthLaunch)
    assertEquals(0, fourthLaunch.attempts)
  }

  @Test
  @Config(sdk = [Build.VERSION_CODES.R])
  fun `later watermark replaces identities and excludes unseen older ANRs`() {
    addAnr(timestamp = 20L, pid = 101)
    addAnr(timestamp = 30L, pid = 102)
    val firstLaunch = BroadcastContext(context)
    AutoMobileAnr.initialize(firstLaunch)

    assertEquals(listOf(101, 102), firstLaunch.events.map { it.pid })
    assertEquals(30L, storedTimestamp())
    assertEquals(setOf(identity(102, context.packageName)), storedIds())
    addAnr(timestamp = 20L, pid = 103)
    addAnr(timestamp = 40L, pid = 104)
    AutoMobileAnr.reset()
    val secondLaunch = BroadcastContext(context)
    AutoMobileAnr.initialize(secondLaunch)

    assertEquals(listOf(104), secondLaunch.events.map { it.pid })
    assertEquals(40L, storedTimestamp())
    assertEquals(setOf(identity(104, context.packageName)), storedIds())
  }

  @Test
  @Config(sdk = [Build.VERSION_CODES.R])
  fun `mid-read failure broadcasts the partial trace with a truncation marker`() {
    val stream = FailingTraceStream("partial trace")
    addAnr(timestamp = 20L, traceStream = stream)
    val recordingContext = BroadcastContext(context)

    AutoMobileAnr.initialize(recordingContext)

    assertEquals(
      "partial trace\n(truncated — trace read failed after 13 chars)\n",
      recordingContext.events.single().trace,
    )
    assertTrue(stream.closed)
    assertTrue(logger.entries.any { it.level == "W" && it.throwable is IOException })
  }

  @Test
  @Config(sdk = [Build.VERSION_CODES.R])
  fun `failure before reading broadcasts a marker-only trace`() {
    addAnr(timestamp = 20L, traceStream = FailingTraceStream(""))
    val recordingContext = BroadcastContext(context)

    AutoMobileAnr.initialize(recordingContext)

    assertEquals(
      "\n(truncated — trace read failed after 0 chars)\n",
      recordingContext.events.single().trace,
    )
  }

  @Test
  @Config(sdk = [Build.VERSION_CODES.R])
  fun `close failure preserves the complete trace with a truncation marker`() {
    val stream =
      object : ByteArrayInputStream("complete trace".toByteArray()) {
        override fun close() {
          throw IOException("Test close failure")
        }
      }
    addAnr(timestamp = 20L, traceStream = stream)
    val recordingContext = BroadcastContext(context)

    AutoMobileAnr.initialize(recordingContext)

    assertEquals(
      "complete trace\n(truncated — trace read failed after 14 chars)\n",
      recordingContext.events.single().trace,
    )
    assertTrue(logger.entries.any { it.level == "W" && it.throwable is IOException })
  }

  @Test
  @Config(sdk = [Build.VERSION_CODES.R])
  fun `missing trace remains null`() {
    addAnr(timestamp = 20L)
    val recordingContext = BroadcastContext(context)
    AutoMobileAnr.initialize(recordingContext)
    assertNull(recordingContext.events.single().trace)
  }

  @Test
  @Config(sdk = [Build.VERSION_CODES.R])
  fun `trace cap keeps its existing truncation marker`() {
    val trace = "a".repeat(200_001)
    addAnr(timestamp = 20L, traceStream = ByteArrayInputStream(trace.toByteArray()))
    val recordingContext = BroadcastContext(context)
    AutoMobileAnr.initialize(recordingContext)
    assertEquals(
      "a".repeat(200_000) + "\n(truncated — trace capped at 200000 chars)\n",
      recordingContext.events.single().trace,
    )
  }

  @Test
  @Config(sdk = [Build.VERSION_CODES.R])
  fun `each ANR is processed and logged once per launch`() {
    addAnr(timestamp = 20L, pid = 101)
    addAnr(timestamp = 30L, pid = 102)
    val firstLaunch = BroadcastContext(context)
    AutoMobileAnr.initialize(firstLaunch)
    assertEquals(2, firstLaunch.attempts)
    for ((pid, timestamp) in listOf(101 to 20L, 102 to 30L)) {
      assertEquals(
        1,
        logger.entries.count {
          it.level == "D" && it.message == "Detected NEW previous ANR: pid=$pid, time=$timestamp"
        },
      )
      assertEquals(
        0,
        logger.entries.count {
          it.level == "D" &&
            it.message ==
              "Skipping already reported ANR: time=$timestamp, identity=${identity(pid, context.packageName)}"
        },
      )
    }
    logger.clear()
    AutoMobileAnr.reset()
    val secondLaunch = BroadcastContext(context)
    AutoMobileAnr.initialize(secondLaunch)

    assertEquals(0, secondLaunch.attempts)
    for ((pid, timestamp) in listOf(101 to 20L, 102 to 30L)) {
      assertEquals(
        1,
        logger.entries.count {
          it.level == "D" &&
            it.message ==
              "Skipping already reported ANR: time=$timestamp, identity=${identity(pid, context.packageName)}"
        },
      )
      assertEquals(
        0,
        logger.entries.count {
          it.level == "D" && it.message == "Detected NEW previous ANR: pid=$pid, time=$timestamp"
        },
      )
    }
  }

  @Test
  @Config(sdk = [Build.VERSION_CODES.R])
  fun `legacy watermark skips all ties but reports later ANRs`() {
    context
      .getSharedPreferences("automobile_anr_prefs", Context.MODE_PRIVATE)
      .edit()
      .putLong("last_reported_anr_timestamp", 20L)
      .commit()
    assertNull(storedIds())
    addAnr(timestamp = 20L, pid = 101)
    val firstLaunch = BroadcastContext(context)
    AutoMobileAnr.initialize(firstLaunch)
    assertEquals(0, firstLaunch.attempts)
    assertNull(storedIds())
    addAnr(timestamp = 30L, pid = 102)
    AutoMobileAnr.reset()
    val secondLaunch = BroadcastContext(context)
    AutoMobileAnr.initialize(secondLaunch)

    assertEquals(listOf(102), secondLaunch.events.map { it.pid })
    assertEquals(30L, storedTimestamp())
    assertEquals(setOf(identity(102, context.packageName)), storedIds())
  }

  @Test
  @Config(sdk = [Build.VERSION_CODES.R])
  fun `present empty identity set permits entries at the watermark`() {
    context
      .getSharedPreferences("automobile_anr_prefs", Context.MODE_PRIVATE)
      .edit()
      .putLong("last_reported_anr_timestamp", 20L)
      .putStringSet("last_reported_anr_ids_at_timestamp", emptySet())
      .commit()
    addAnr(timestamp = 20L, pid = 101)
    val recordingContext = BroadcastContext(context)
    AutoMobileAnr.initialize(recordingContext)
    assertEquals(listOf(101), recordingContext.events.map { it.pid })
    assertEquals(setOf(identity(101, context.packageName)), storedIds())
  }

  @Test
  @Config(sdk = [Build.VERSION_CODES.R])
  fun `identities distinguish empty and separator-containing process names`() {
    val names = listOf("", "null", "worker:3:pid")
    for (name in names) addAnr(timestamp = 20L, pid = 101, processName = name)
    val firstLaunch = BroadcastContext(context)
    AutoMobileAnr.initialize(firstLaunch)
    assertEquals(3, firstLaunch.attempts)
    assertEquals(names.toSet(), firstLaunch.events.map { it.processName }.toSet())
    assertEquals(names.map { identity(101, it) }.toSet(), storedIds())
    AutoMobileAnr.reset()
    val secondLaunch = BroadcastContext(context)
    AutoMobileAnr.initialize(secondLaunch)
    assertEquals(0, secondLaunch.attempts)
  }

  private fun addAnr(
    timestamp: Long,
    pid: Int = 123,
    processName: String = context.packageName,
    traceStream: InputStream? = null,
  ) {
    val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val exitInfo =
      ApplicationExitInfoBuilder.newBuilder()
        .setReason(ApplicationExitInfo.REASON_ANR)
        .setTimestamp(timestamp)
        .setPid(pid)
        .setProcessName(processName)
        .setTraceInputStream(traceStream)
        .build()
    shadowOf(activityManager).addApplicationExitInfo(exitInfo)
  }

  private fun storedTimestamp(): Long =
    context
      .getSharedPreferences("automobile_anr_prefs", Context.MODE_PRIVATE)
      .getLong("last_reported_anr_timestamp", 0L)

  private fun storedIds(): Set<String>? =
    context
      .getSharedPreferences("automobile_anr_prefs", Context.MODE_PRIVATE)
      .getStringSet("last_reported_anr_ids_at_timestamp", null)
      ?.toSet()

  private fun identity(pid: Int, processName: String): String =
    "$pid:${processName.length}:$processName"

  private class BroadcastContext(
    base: Context,
    private val fail: Boolean = false,
    private val failOnAttempts: Set<Int> = emptySet(),
  ) : ContextWrapper(base) {
    val broadcasts = mutableListOf<Intent>()
    val attemptedEvents = mutableListOf<SdkAnrEvent>()
    val events: List<SdkAnrEvent>
      get() = broadcasts.map {
        SdkEventSerializer.fromJson(it.getStringExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON)!!)
          as SdkAnrEvent
      }

    var attempts = 0
      private set

    override fun getApplicationContext(): Context = this

    override fun sendBroadcast(intent: Intent) {
      attempts++
      attemptedEvents.add(
        SdkEventSerializer.fromJson(
          intent.getStringExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON)!!
        ) as SdkAnrEvent
      )
      if (fail || attempts in failOnAttempts) throw IllegalStateException("Test broadcast failure")
      broadcasts.add(intent)
    }
  }

  private class FailingTraceStream(text: String) : InputStream() {
    private val bytes = text.toByteArray(Charsets.UTF_8)
    private var offset = 0
    var closed = false
      private set

    override fun read(): Int {
      if (offset == bytes.size) throw IOException("Test trace read failure")
      return bytes[offset++].toInt() and 0xff
    }

    override fun read(buffer: ByteArray, off: Int, len: Int): Int {
      if (len == 0) return 0
      if (offset == bytes.size) throw IOException("Test trace read failure")
      val count = minOf(len, bytes.size - offset)
      bytes.copyInto(buffer, off, offset, offset + count)
      offset += count
      return count
    }

    override fun close() {
      closed = true
    }
  }
}
