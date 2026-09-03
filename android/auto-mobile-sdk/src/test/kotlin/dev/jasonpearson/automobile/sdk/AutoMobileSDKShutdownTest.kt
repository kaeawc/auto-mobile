package dev.jasonpearson.automobile.sdk

import dev.jasonpearson.automobile.sdk.crashes.AutoMobileCrashes
import dev.jasonpearson.automobile.sdk.database.DatabaseInspector
import dev.jasonpearson.automobile.sdk.storage.SharedPreferencesInspector
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.shadows.ShadowLooper

@RunWith(RobolectricTestRunner::class)
class AutoMobileSDKShutdownTest {
  private val context = RuntimeEnvironment.getApplication()
  private lateinit var originalHandler: Thread.UncaughtExceptionHandler

  @Before
  fun setUp() {
    AutoMobileSDK.shutdown()
    ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
    AutoMobileCrashes.uninstall()
    DatabaseInspector.reset()
    SharedPreferencesInspector.reset()
    originalHandler = Thread.UncaughtExceptionHandler { _, _ -> }
    Thread.setDefaultUncaughtExceptionHandler(originalHandler)
  }

  @After
  fun tearDown() {
    AutoMobileSDK.shutdown()
    ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
    Thread.setDefaultUncaughtExceptionHandler(originalHandler)
  }

  @Test
  fun `shutdown restores crash handling and inspector state`() {
    AutoMobileSDK.initialize(context)
    ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
    DatabaseInspector.setEnabled(true)
    SharedPreferencesInspector.setEnabled(true)

    AutoMobileSDK.shutdown()
    ShadowLooper.runUiThreadTasksIncludingDelayedTasks()

    assertSame(originalHandler, Thread.getDefaultUncaughtExceptionHandler())
    assertFalse(AutoMobileCrashes.isInitialized())
    assertFalse(DatabaseInspector.isEnabled())
    assertFalse(SharedPreferencesInspector.isEnabled())
  }

  @Test
  fun `a shutdown cycle reinitializes without retaining crash handler state`() {
    AutoMobileSDK.initialize(context)
    ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
    AutoMobileSDK.shutdown()
    ShadowLooper.runUiThreadTasksIncludingDelayedTasks()

    AutoMobileSDK.initialize(context)
    ShadowLooper.runUiThreadTasksIncludingDelayedTasks()

    assertTrue(AutoMobileCrashes.isInitialized())

    AutoMobileSDK.shutdown()
    ShadowLooper.runUiThreadTasksIncludingDelayedTasks()

    assertSame(originalHandler, Thread.getDefaultUncaughtExceptionHandler())
  }

  @Test
  fun `setEnabled disables capture without uninstalling runtime hooks`() {
    AutoMobileSDK.initialize(context)
    ShadowLooper.runUiThreadTasksIncludingDelayedTasks()

    AutoMobileSDK.setEnabled(false)

    assertFalse(AutoMobileSDK.isTrackingEnabled)
    assertTrue(AutoMobileCrashes.isInitialized())
  }
}
