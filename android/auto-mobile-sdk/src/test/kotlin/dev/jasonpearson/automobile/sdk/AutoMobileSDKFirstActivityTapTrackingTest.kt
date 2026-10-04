package dev.jasonpearson.automobile.sdk

import android.app.Activity
import android.content.ComponentName
import android.content.ContextWrapper
import android.os.Bundle
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.view.Window
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import dev.jasonpearson.automobile.sdk.crashes.AutoMobileCrashes
import dev.jasonpearson.automobile.sdk.database.DatabaseInspector
import dev.jasonpearson.automobile.sdk.interaction.AutoMobileClickTracker
import dev.jasonpearson.automobile.sdk.storage.SharedPreferencesInspector
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.shadows.ShadowLog

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
@LooperMode(LooperMode.Mode.PAUSED)
class AutoMobileSDKFirstActivityTapTrackingTest {
  private val context = RuntimeEnvironment.getApplication()
  private var originalHandler: Thread.UncaughtExceptionHandler? = null

  @Before
  fun setUp() {
    originalHandler = Thread.getDefaultUncaughtExceptionHandler()
    AutoMobileSDK.shutdown()
    shadowOf(Looper.getMainLooper()).idle()
    AutoMobileCrashes.uninstall()
    DatabaseInspector.reset()
    SharedPreferencesInspector.reset()
    ShadowLog.clear()
  }

  @After
  fun tearDown() {
    AutoMobileSDK.shutdown()
    shadowOf(Looper.getMainLooper()).idle()
    Thread.setDefaultUncaughtExceptionHandler(originalHandler)
    ShadowLog.clear()
  }

  @Test
  fun `initializing before super onCreate tracks the first Activity tap`() {
    assertFirstActivityTapTracked(InitializeBeforeSuperActivity::class.java)
  }

  @Test
  fun `initializing after super onCreate tracks the first Activity tap`() {
    assertFirstActivityTapTracked(InitializeAfterSuperActivity::class.java)
  }

  @Test
  fun `initializing from Application context wraps the next Activity`() {
    AutoMobileSDK.initialize(context)
    shadowOf(Looper.getMainLooper()).idle()

    createActivity(TestActivity::class.java).use { controller ->
      val activity = controller.get()
      val originalCallback = activity.window.callback
      controller.start().resume()
      shadowOf(Looper.getMainLooper()).idle()

      assertWrappedOnce(activity, originalCallback)
      assertSingleTapDelegatedAndLogged(activity)
    }
  }

  @Test
  fun `initializing with an already resumed Activity context wraps it once`() {
    createActivity(TestActivity::class.java).use { controller ->
      val activity = controller.get()
      val originalCallback = activity.window.callback
      controller.start().resume()

      AutoMobileSDK.initialize(ContextWrapper(ContextWrapper(activity)))
      val wrapper = assertWrappedOnce(activity, originalCallback)
      shadowOf(Looper.getMainLooper()).idle()

      assertSame(wrapper, assertWrappedOnce(activity, originalCallback))
      controller.pause().resume().pause().resume()
      assertSame(wrapper, assertWrappedOnce(activity, originalCallback))
      assertSingleTapDelegatedAndLogged(activity)
    }
  }

  @Test
  @Config(sdk = [29])
  fun `Application initialization after resume wraps at post resumed`() {
    createActivity(InitializeAfterPostResumeActivity::class.java).use { controller ->
      val activity = controller.get()
      val originalCallback = activity.window.callback
      controller.start().resume()

      assertWrappedOnce(activity, originalCallback)
      assertSingleTapDelegatedAndLogged(activity)
    }
  }

  @Test
  fun `late Application initialization catches up at the next pause`() {
    createActivity(TestActivity::class.java).use { controller ->
      val activity = controller.get()
      val originalCallback = activity.window.callback
      controller.start().resume()

      AutoMobileSDK.initialize(context)
      shadowOf(Looper.getMainLooper()).idle()
      // An Application cannot supply the Activity until another eligible lifecycle callback.
      assertSame(originalCallback, activity.window.callback)
      controller.pause()
      val wrapper = assertWrappedOnce(activity, originalCallback)
      controller.resume().pause().resume()
      assertSame(wrapper, assertWrappedOnce(activity, originalCallback))
      assertSingleTapDelegatedAndLogged(activity)
    }
  }

  @Test
  fun `Activity context initialization before resume preserves framework callback setup`() {
    createActivity(LifecycleActivity::class.java).use { controller ->
      val activity = controller.get()
      val originalCallback = activity.window.callback
      AutoMobileSDK.initialize(activity)
      assertSame(originalCallback, activity.window.callback)
      val frameworkCallback = object : Window.Callback by originalCallback {}
      activity.window.callback = frameworkCallback

      controller.start().resume()
      shadowOf(Looper.getMainLooper()).idle()

      assertWrappedOnce(activity, frameworkCallback)
      assertSingleTapDelegatedAndLogged(activity)
    }
  }

  @Test
  fun `shutdown cancels a pending Activity catch up`() {
    createActivity(LifecycleActivity::class.java).use { controller ->
      val activity = controller.get()
      val originalCallback = activity.window.callback
      AutoMobileSDK.initialize(activity)
      AutoMobileSDK.shutdown()
      shadowOf(Looper.getMainLooper()).idle()

      assertSame(originalCallback, activity.window.callback)
      controller.start().resume()
      assertSame(originalCallback, activity.window.callback)
    }
  }

  @Test
  fun `off main initialization with an already resumed Activity wraps on main`() {
    createActivity(TestActivity::class.java).use { controller ->
      val activity = controller.get()
      val originalCallback = activity.window.callback
      controller.start().resume()
      var initializationFailure: Throwable? = null
      val thread = Thread {
        try {
          AutoMobileSDK.initialize(ContextWrapper(ContextWrapper(activity)))
        } catch (error: Throwable) {
          initializationFailure = error
        }
      }
      thread.start()
      thread.join()

      assertNull(initializationFailure)
      assertSame(originalCallback, activity.window.callback)
      shadowOf(Looper.getMainLooper()).idle()
      assertWrappedOnce(activity, originalCallback)
      assertSingleTapDelegatedAndLogged(activity)
    }
  }

  @Test
  fun `destroy restores the window callback and releases the Activity`() {
    AutoMobileSDK.initialize(context)
    createActivity(TestActivity::class.java).use { controller ->
      val activity = controller.get()
      val originalCallback = activity.window.callback
      controller.start().resume()
      assertWrappedOnce(activity, originalCallback)

      controller.pause().stop().destroy()

      assertSame(originalCallback, activity.window.callback)
      val wrappedActivities =
        AutoMobileClickTracker.javaClass
          .getDeclaredField("wrappedActivities")
          .apply { isAccessible = true }
          .get(AutoMobileClickTracker) as Map<*, *>
      assertFalse(wrappedActivities.containsKey(activity))
    }
  }

  @Test
  fun `shutdown restores the window callback of a live Activity`() {
    AutoMobileSDK.initialize(context)
    createActivity(TestActivity::class.java).use { controller ->
      val activity = controller.get()
      val originalCallback = activity.window.callback
      controller.start().resume()
      assertWrappedOnce(activity, originalCallback)

      AutoMobileSDK.shutdown()

      assertSame(originalCallback, activity.window.callback)
      controller.pause().resume()
      assertSame(originalCallback, activity.window.callback)
    }
  }

  @Test
  fun `pause and resume do not double wrap the initializing Activity`() {
    createActivity(InitializeAfterSuperActivity::class.java).use { controller ->
      val activity = controller.get()
      val originalCallback = activity.window.callback
      controller.start().resume()
      shadowOf(Looper.getMainLooper()).idle()
      val firstWrapper = assertWrappedOnce(activity, originalCallback)

      controller.pause().resume()
      shadowOf(Looper.getMainLooper()).idle()

      assertSame(firstWrapper, assertWrappedOnce(activity, originalCallback))
      assertSingleTapDelegatedAndLogged(activity)
    }
  }

  @Test
  fun `a second Activity is wrapped after initialization in the first`() {
    createActivity(InitializeAfterSuperActivity::class.java).use { first ->
      val firstActivity = first.get()
      val firstCallback = firstActivity.window.callback
      first.start().resume()
      shadowOf(Looper.getMainLooper()).idle()
      assertWrappedOnce(firstActivity, firstCallback)
      first.pause()

      createActivity(TestActivity::class.java).use { second ->
        val secondActivity = second.get()
        val secondCallback = secondActivity.window.callback
        second.start().resume()
        shadowOf(Looper.getMainLooper()).idle()

        assertWrappedOnce(secondActivity, secondCallback)
        assertSingleTapDelegatedAndLogged(secondActivity)
      }
    }
  }

  @Test
  fun `off main initialization posts lifecycle setup until the main looper idles`() {
    var initializationFailure: Throwable? = null
    val thread = Thread {
      try {
        AutoMobileSDK.initialize(context)
      } catch (error: Throwable) {
        initializationFailure = error
      }
    }
    thread.start()
    thread.join()

    assertNull(initializationFailure)
    assertFalse(RecompositionTracker.isEnabled())
    shadowOf(Looper.getMainLooper()).idle()
    assertTrue(RecompositionTracker.isEnabled())

    createActivity(TestActivity::class.java).use { controller ->
      val activity = controller.get()
      val originalCallback = activity.window.callback
      controller.start().resume()
      shadowOf(Looper.getMainLooper()).idle()

      assertWrappedOnce(activity, originalCallback)
      assertSingleTapDelegatedAndLogged(activity)
    }
  }

  private fun <T : TestActivity> createActivity(activityClass: Class<T>): ActivityController<T> {
    shadowOf(context.packageManager).addActivityIfNotPresent(ComponentName(context, activityClass))
    return Robolectric.buildActivity(activityClass).create()
  }

  private fun <T : TestActivity> assertFirstActivityTapTracked(activityClass: Class<T>) {
    createActivity(activityClass).use { controller ->
      val activity = controller.get()
      val originalCallback = activity.window.callback
      // Do not idle between create and resume: Android delivers launch in one main-looper message.
      controller.start().resume()
      shadowOf(Looper.getMainLooper()).idle()

      assertWrappedOnce(activity, originalCallback)
      assertSingleTapDelegatedAndLogged(activity)
    }
  }

  private fun assertWrappedOnce(
    activity: Activity,
    originalCallback: Window.Callback,
  ): Window.Callback {
    val callback = activity.window.callback
    assertNotSame(originalCallback, callback)
    assertTrue(callback.javaClass.name.endsWith("ClickTrackingCallback"))
    val delegate =
      callback.javaClass.getDeclaredField("delegate").apply { isAccessible = true }.get(callback)
    assertSame(originalCallback, delegate)
    assertFalse(delegate.javaClass.name.endsWith("ClickTrackingCallback"))
    return callback
  }

  private fun assertSingleTapDelegatedAndLogged(activity: TestActivity) {
    assertTrue(AutoMobileSDK.isTrackingEnabled)
    assertTrue(activity.touchActions.isEmpty())
    assertTrue(
      ShadowLog.getLogsForTag("AutoMobileClickTracker").none { it.msg.startsWith("_auto_tap ") }
    )
    val downTime = SystemClock.uptimeMillis()
    val down = MotionEvent.obtain(downTime, downTime, MotionEvent.ACTION_DOWN, 10f, 10f, 0)
    val up = MotionEvent.obtain(downTime, downTime + 1, MotionEvent.ACTION_UP, 10f, 10f, 0)
    try {
      assertTrue(activity.window.callback.dispatchTouchEvent(down))
      assertTrue(activity.window.callback.dispatchTouchEvent(up))
    } finally {
      down.recycle()
      up.recycle()
    }
    shadowOf(Looper.getMainLooper()).idle()

    assertEquals(listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP), activity.touchActions)
    val taps =
      ShadowLog.getLogsForTag("AutoMobileClickTracker").filter { it.msg.startsWith("_auto_tap ") }
    assertEquals(1, taps.size)
    assertEquals(Log.DEBUG, taps.single().type)
    assertTrue(taps.single().msg.contains("x=10 y=10"))
  }

  open class TestActivity : Activity() {
    val touchActions = mutableListOf<Int>()

    override fun onCreate(savedInstanceState: Bundle?) {
      super.onCreate(savedInstanceState)
      setContentView(View(this))
    }

    override fun dispatchTouchEvent(event: MotionEvent?): Boolean {
      if (event != null) touchActions.add(event.actionMasked)
      return true
    }
  }

  class InitializeBeforeSuperActivity : TestActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
      AutoMobileSDK.initialize(applicationContext)
      super.onCreate(savedInstanceState)
    }
  }

  class InitializeAfterSuperActivity : TestActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
      super.onCreate(savedInstanceState)
      AutoMobileSDK.initialize(applicationContext)
    }
  }

  class InitializeAfterPostResumeActivity : TestActivity() {
    override fun onPostResume() {
      super.onPostResume()
      AutoMobileSDK.initialize(applicationContext)
    }
  }

  class LifecycleActivity : TestActivity(), LifecycleOwner {
    override val lifecycle = LifecycleRegistry(this)

    override fun onCreate(savedInstanceState: Bundle?) {
      super.onCreate(savedInstanceState)
      lifecycle.currentState = Lifecycle.State.CREATED
    }

    override fun onResume() {
      super.onResume()
      lifecycle.currentState = Lifecycle.State.RESUMED
    }
  }
}
