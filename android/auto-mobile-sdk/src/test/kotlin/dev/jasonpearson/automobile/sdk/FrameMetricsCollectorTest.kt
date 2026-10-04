package dev.jasonpearson.automobile.sdk

import android.app.Activity
import android.os.Build
import android.os.Looper
import android.view.Window
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
import org.robolectric.shadows.ShadowWindow

@RunWith(RobolectricTestRunner::class)
// The default Robolectric SDK's android-all lacks the Window frame-metrics listener methods.
@Config(sdk = [Build.VERSION_CODES.TIRAMISU])
@LooperMode(LooperMode.Mode.PAUSED)
class FrameMetricsCollectorTest {
  private lateinit var controller: ActivityController<Activity>

  @Before
  fun setUp() {
    FrameMetricsCollector.reset()
    FrameMetricsCollector.initialize(RuntimeEnvironment.getApplication())
    // Keep Activity construction outside the timed test body.
    controller = Robolectric.buildActivity(Activity::class.java).create()
  }

  @After
  fun tearDown() {
    FrameMetricsCollector.reset()
    controller.close()
    shadowOf(Looper.getMainLooper()).idle()
  }

  @Test
  fun `enabling attaches an Activity that is already resumed`() {
    controller.start().resume()
    assertEquals(0, listenerCount())

    FrameMetricsCollector.setEnabled(true)

    assertEquals(1, listenerCount())
  }

  @Test
  fun `reenabling reattaches the foreground window exactly once`() {
    FrameMetricsCollector.setEnabled(true)
    controller.start().resume()
    assertEquals(1, listenerCount())

    FrameMetricsCollector.setEnabled(false)
    assertEquals(0, listenerCount())
    FrameMetricsCollector.setEnabled(true)
    assertEquals(1, listenerCount())
    FrameMetricsCollector.setEnabled(true)
    assertEquals(1, listenerCount())
  }

  @Test
  fun `Activity started after enabling attaches through Application callbacks`() {
    FrameMetricsCollector.setEnabled(true)
    assertEquals(0, listenerCount())

    controller.start().resume()

    assertEquals(1, listenerCount())
  }

  @Test
  fun `stopping removes the window and its tracked Activity`() {
    controller.start().resume()
    FrameMetricsCollector.setEnabled(true)
    assertEquals(1, listenerCount())

    controller.pause().stop()
    assertEquals(0, listenerCount())
    FrameMetricsCollector.setEnabled(false)
    FrameMetricsCollector.setEnabled(true)
    // The controller still holds the Activity, so this proves removal without relying on GC.
    assertEquals(0, listenerCount())
    controller.destroy()
    assertEquals(0, listenerCount())
  }

  @Test
  fun `destroying removes the window and its tracked Activity without a stop callback`() {
    controller.start().resume()
    FrameMetricsCollector.setEnabled(true)
    assertEquals(1, listenerCount())
    val window = controller.get().window

    // Exercise the defensive destroy path independently of onActivityStopped.
    controller.pause().destroy()
    assertEquals(0, listenerCount(window))
    FrameMetricsCollector.setEnabled(false)
    FrameMetricsCollector.setEnabled(true)
    assertEquals(0, listenerCount(window))
  }

  @Test
  fun `Activity started during a disabled interval attaches on enabling`() {
    FrameMetricsCollector.setEnabled(true)
    FrameMetricsCollector.setEnabled(false)
    controller.start().resume()
    assertEquals(0, listenerCount())

    FrameMetricsCollector.setEnabled(true)

    assertEquals(1, listenerCount())
  }

  @Test
  fun `off main enable posts attachment until the main looper runs`() {
    controller.start().resume()

    enableOffMainThread()
    assertEquals(0, listenerCount())
    shadowOf(Looper.getMainLooper()).idle()

    assertEquals(1, listenerCount())
  }

  @Test
  fun `disabling cancels a pending off main attachment`() {
    controller.start().resume()
    enableOffMainThread()
    assertEquals(0, listenerCount())

    FrameMetricsCollector.setEnabled(false)
    shadowOf(Looper.getMainLooper()).idle()

    assertEquals(0, listenerCount())
  }

  @Test
  fun `pending off main attachment skips an Activity that has stopped`() {
    controller.start().resume()
    enableOffMainThread()
    assertEquals(0, listenerCount())

    controller.pause().stop()
    shadowOf(Looper.getMainLooper()).idle()

    assertEquals(0, listenerCount())
    FrameMetricsCollector.setEnabled(false)
    FrameMetricsCollector.setEnabled(true)
    assertEquals(0, listenerCount())
  }

  @Test
  fun `reset clears tracking and unregisters lifecycle callbacks`() {
    controller.start().resume()
    FrameMetricsCollector.setEnabled(true)
    assertEquals(1, listenerCount())

    FrameMetricsCollector.reset()
    controller.pause().stop().start().resume()
    FrameMetricsCollector.initialize(RuntimeEnvironment.getApplication())
    FrameMetricsCollector.setEnabled(true)

    // The original start was cleared; the subsequent start happened before reinitialization.
    assertEquals(0, listenerCount())
    controller.pause().stop().start().resume()
    assertEquals(1, listenerCount())
  }

  private fun listenerCount(window: Window = controller.get().window): Int {
    // Read Robolectric's actual listener registrations, rather than SDK bookkeeping or a new seam.
    val field = ShadowWindow::class.java.getDeclaredField("onFrameMetricsAvailableListeners")
    field.isAccessible = true
    return (field.get(shadowOf(window)) as Set<*>).size
  }

  private fun enableOffMainThread() {
    val task = FutureTask { FrameMetricsCollector.setEnabled(true) }
    Thread(task, "frame-metrics-test-enable").start()
    // Propagate worker failures and wait for posting, without sleeps or advancing virtual time.
    task.get(5, TimeUnit.SECONDS)
  }

  @Test
  fun `buildSnapshotJson aggregates fps, jank, and average frame time`() {
    val window =
      listOf(
        FrameMetricsCollector.FrameSample(t = 0, durationMs = 10.0),
        FrameMetricsCollector.FrameSample(t = 0, durationMs = 20.0), // jank (> 16.7ms)
        FrameMetricsCollector.FrameSample(t = 0, durationMs = 30.0), // jank
      )

    val json = JSONObject(FrameMetricsCollector.buildSnapshotJson("com.example", window, 1000L))

    assertEquals("com.example", json.getString("applicationId"))
    assertEquals(3, json.getInt("totalFrames"))
    assertEquals(20.0, json.getDouble("frameTimeMs"), 0.001) // (10 + 20 + 30) / 3
    assertEquals(2, json.getInt("jankFrames")) // 20ms and 30ms exceed the 16.7ms threshold
    assertEquals(50.0, json.getDouble("fps"), 0.001) // 1000 / 20ms
  }

  @Test
  fun `buildSnapshotJson omits frame fields when no frames rendered`() {
    val json =
      JSONObject(FrameMetricsCollector.buildSnapshotJson("com.example", emptyList(), 1000L))

    assertEquals(0, json.getInt("totalFrames"))
    assertFalse(json.has("fps"))
    assertFalse(json.has("frameTimeMs"))
    assertFalse(json.has("jankFrames"))
  }
}
