package dev.jasonpearson.automobile.sdk.crashes

import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import java.util.concurrent.atomic.AtomicInteger
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

/**
 * Unit tests for [AutoMobileCrashes] install/uninstall of the default uncaught exception handler.
 * Crash detection carries a "🧪 Tested" chip in the design doc, so pin the handler capture/restore
 * contract (the safety-critical part: we must chain to and later restore whatever handler was
 * already installed).
 */
@RunWith(RobolectricTestRunner::class)
class AutoMobileCrashesTest {

  private val context: android.content.Context = RuntimeEnvironment.getApplication()
  private var priorDefaultHandler: Thread.UncaughtExceptionHandler? = null

  @Before
  fun setup() {
    // Ensure a clean, known baseline: AutoMobileCrashes is a singleton object, so
    // a prior test could have left it installed.
    AutoMobileCrashes.uninstall()
    priorDefaultHandler = Thread.getDefaultUncaughtExceptionHandler()
  }

  @After
  fun tearDown() {
    AutoMobileCrashes.uninstall()
    Thread.setDefaultUncaughtExceptionHandler(priorDefaultHandler)
  }

  @Test
  fun `initialize installs its own handler and marks initialized`() {
    val original = Thread.getDefaultUncaughtExceptionHandler()

    AutoMobileCrashes.initialize(context)

    assertTrue(AutoMobileCrashes.isInitialized())
    assertNotSame(
      "initialize must replace the default uncaught handler",
      original,
      Thread.getDefaultUncaughtExceptionHandler(),
    )
  }

  @Test
  fun `uninstall restores the original handler and clears initialized`() {
    val original = Thread.UncaughtExceptionHandler { _, _ -> }
    Thread.setDefaultUncaughtExceptionHandler(original)

    AutoMobileCrashes.initialize(context)
    AutoMobileCrashes.uninstall()

    assertFalse(AutoMobileCrashes.isInitialized())
    assertSame(
      "uninstall must restore the handler present before initialize",
      original,
      Thread.getDefaultUncaughtExceptionHandler(),
    )
  }

  @Test
  fun `initialize is idempotent - second call does not re-capture`() {
    val original = Thread.UncaughtExceptionHandler { _, _ -> }
    Thread.setDefaultUncaughtExceptionHandler(original)

    AutoMobileCrashes.initialize(context)
    val afterFirst = Thread.getDefaultUncaughtExceptionHandler()
    // A second initialize must not treat AutoMobile's own handler as the
    // "original" to restore later.
    AutoMobileCrashes.initialize(context)

    assertSame(afterFirst, Thread.getDefaultUncaughtExceptionHandler())

    AutoMobileCrashes.uninstall()
    assertSame(
      "after the idempotent second init, uninstall still restores the true original",
      original,
      Thread.getDefaultUncaughtExceptionHandler(),
    )
  }

  @Test
  fun `uninstall does not clobber a foreign handler installed after us`() {
    AutoMobileCrashes.initialize(context)

    // Another crash reporter installs its handler after AutoMobile.
    val foreign = Thread.UncaughtExceptionHandler { _, _ -> }
    Thread.setDefaultUncaughtExceptionHandler(foreign)

    AutoMobileCrashes.uninstall()

    assertSame(
      "uninstall must leave a later-installed foreign handler untouched",
      foreign,
      Thread.getDefaultUncaughtExceptionHandler(),
    )
  }

  @Test
  fun `broadcast failure with an Exception still invokes the original handler exactly once`() {
    val originalCalls = AtomicInteger()
    val original = Thread.UncaughtExceptionHandler { _, _ -> originalCalls.incrementAndGet() }
    Thread.setDefaultUncaughtExceptionHandler(original)
    AutoMobileCrashes.initialize(context)
    AutoMobileCrashes.currentScreenProvider = { throw RuntimeException("boom") }

    Thread.getDefaultUncaughtExceptionHandler()!!.uncaughtException(
      Thread.currentThread(),
      RuntimeException("crash"),
    )

    assertEquals(1, originalCalls.get())
  }

  @Test
  fun `broadcast failure with an Error still invokes the original handler exactly once`() {
    val originalCalls = AtomicInteger()
    val original = Thread.UncaughtExceptionHandler { _, _ -> originalCalls.incrementAndGet() }
    Thread.setDefaultUncaughtExceptionHandler(original)
    AutoMobileCrashes.initialize(context)
    AutoMobileCrashes.currentScreenProvider = { throw OutOfMemoryError() }

    Thread.getDefaultUncaughtExceptionHandler()!!.uncaughtException(
      Thread.currentThread(),
      RuntimeException("crash"),
    )

    assertEquals(1, originalCalls.get())
  }

  @Test
  fun `no original handler does not throw`() {
    Thread.setDefaultUncaughtExceptionHandler(null)
    AutoMobileCrashes.initialize(context)
    AutoMobileCrashes.currentScreenProvider = { throw OutOfMemoryError() }
    val handler = Thread.getDefaultUncaughtExceptionHandler()

    assertNotNull(handler)
    handler!!.uncaughtException(Thread.currentThread(), RuntimeException("crash"))
  }

  @Test
  fun `tracking disabled still invokes the original handler exactly once`() {
    val originalCalls = AtomicInteger()
    val original = Thread.UncaughtExceptionHandler { _, _ -> originalCalls.incrementAndGet() }
    Thread.setDefaultUncaughtExceptionHandler(original)
    AutoMobileCrashes.initialize(context)

    try {
      AutoMobileSDK.setEnabled(false)
      Thread.getDefaultUncaughtExceptionHandler()!!.uncaughtException(
        Thread.currentThread(),
        RuntimeException("crash"),
      )

      assertEquals(1, originalCalls.get())
    } finally {
      AutoMobileSDK.setEnabled(true)
    }
  }

  @Test
  fun `uninstalled handler retained by a later reporter forwards to its original handler`() {
    val originalCalls = AtomicInteger()
    val original = Thread.UncaughtExceptionHandler { _, _ -> originalCalls.incrementAndGet() }
    Thread.setDefaultUncaughtExceptionHandler(original)
    AutoMobileCrashes.initialize(context)
    val autoMobileHandler = Thread.getDefaultUncaughtExceptionHandler()
    val foreign = Thread.UncaughtExceptionHandler { thread, throwable ->
      autoMobileHandler?.uncaughtException(thread, throwable)
    }
    Thread.setDefaultUncaughtExceptionHandler(foreign)

    AutoMobileCrashes.uninstall()
    foreign.uncaughtException(Thread.currentThread(), RuntimeException("test crash"))

    assertSame(foreign, Thread.getDefaultUncaughtExceptionHandler())
    assertEquals("a retained handler must forward to its predecessor", 1, originalCalls.get())
  }
}
