package dev.jasonpearson.automobile.ctrlproxy

import android.accessibilityservice.AccessibilityService.ScreenshotResult
import android.accessibilityservice.AccessibilityService.TakeScreenshotCallback
import android.graphics.Bitmap
import android.graphics.ColorSpace
import android.hardware.HardwareBuffer
import android.hardware.display.DisplayManager
import android.util.Base64
import android.view.Display
import android.view.WindowManager
import dev.jasonpearson.automobile.ctrlproxy.models.ScreenDimensions
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkStatic
import io.mockk.unmockkStatic
import java.io.OutputStream
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class ScreenshotControllerTest {
  private class SteppingTimer : TimeProvider {
    private var now = 1_000L

    override fun currentTimeMillis(): Long = now.also { now += 10 }
  }

  private class FakeSignal : RotationChangeSignal {
    var listener: ((Int) -> Unit)? = null

    override fun register(listener: (Int) -> Unit): Boolean {
      this.listener = listener
      return true
    }

    override fun synchronize() = true

    override fun unregister() {
      listener = null
    }
  }

  private class FakeHost(val provenance: RotationProvenanceTracker) : ScreenshotController.Host {
    val requestedDisplays = mutableListOf<Int>()
    var behavior: (TakeScreenshotCallback) -> Unit = {}

    override fun takeScreenshot(displayId: Int, callback: TakeScreenshotCallback) {
      requestedDisplays += displayId
      behavior(callback)
    }

    override fun rotationProvenance() = provenance
  }

  private class FakeDisplayHost(var rotation: Int) : DisplayController.Host {
    override fun displayManager(): DisplayManager {
      val display = mockk<Display>(relaxed = true)
      every { display.rotation } returns rotation
      return mockk { every { getDisplay(any()) } returns display }
    }

    override fun windowManager(): WindowManager? = null

    override fun displayInsetsProvider(): DisplayInsetsProvider =
      object : DisplayInsetsProvider {
        override fun insetsFor(displayId: Int, screenDimensions: ScreenDimensions?) =
          dev.jasonpearson.automobile.ctrlproxy.models.ObservationInsetsInfo()
      }

    override fun frameworkDimenPx(name: String) = 0

    override fun densityDpi() = 420
  }

  private val signal = FakeSignal()
  private val host = FakeHost(RotationProvenanceTracker(signal))
  private val displayHost = FakeDisplayHost(rotation = 1)
  private val controller =
    ScreenshotController(host, DisplayController(displayHost), SteppingTimer())

  private val jpeg = byteArrayOf(1, 2, 3, 4, 5)

  @Before
  fun stubBitmaps() {
    val software = mockk<Bitmap>(relaxed = true)
    every { software.compress(Bitmap.CompressFormat.JPEG, 80, any()) } answers
      {
        thirdArg<OutputStream>().write(jpeg)
        true
      }
    val hardware = mockk<Bitmap>(relaxed = true)
    every { hardware.width } returns 1080
    every { hardware.height } returns 2400
    every { hardware.copy(Bitmap.Config.ARGB_8888, false) } returns software
    mockkStatic(Bitmap::class)
    every { Bitmap.wrapHardwareBuffer(any<HardwareBuffer>(), any<ColorSpace>()) } returns hardware
  }

  @After
  fun unstub() {
    unmockkStatic(Bitmap::class)
  }

  private fun screenshotResult(): ScreenshotResult {
    val buffer =
      HardwareBuffer.create(
        1,
        1,
        HardwareBuffer.RGBA_8888,
        1,
        HardwareBuffer.USAGE_CPU_READ_RARELY,
      )
    val constructor =
      ScreenshotResult::class
        .java
        .getDeclaredConstructor(
          HardwareBuffer::class.java,
          ColorSpace::class.java,
          Long::class.javaPrimitiveType,
        )
    constructor.isAccessible = true
    return constructor.newInstance(buffer, ColorSpace.get(ColorSpace.Named.SRGB), 0L)
  }

  @Test
  fun successEncodesJpegAndReportsTimedDiagnostics() = runTest {
    host.behavior = { it.onSuccess(screenshotResult()) }

    val outcome = controller.takeScreenshotAsync(targetDisplayId = 0)

    val payload = (outcome as ScreenshotCaptureOutcome.Success).payload
    assertEquals(Base64.encodeToString(jpeg, Base64.NO_WRAP), payload.base64Image)
    assertEquals(jpeg.size, payload.byteLength)
    assertEquals(payload.base64Image.length, payload.base64Length)
    assertEquals(0, payload.displayId)
    assertEquals(1, payload.rotation)
    assertTrue(payload.captureDurationMs > 0)
    assertTrue(payload.encodeDurationMs > 0)
    assertEquals(listOf(0), host.requestedDisplays)
  }

  @Test
  fun capturePassesTheRequestedDisplayToThePlatform() = runTest {
    host.behavior = { it.onSuccess(screenshotResult()) }

    val payload =
      (controller.takeScreenshotAsync(targetDisplayId = 7) as ScreenshotCaptureOutcome.Success)
        .payload

    assertEquals(listOf(7), host.requestedDisplays)
    assertEquals(7, payload.displayId)
  }

  @Test
  fun rotationIsDroppedWhenTheDisplayChangesMidCapture() = runTest {
    host.behavior = {
      signal.listener!!.invoke(0)
      it.onSuccess(screenshotResult())
    }

    val payload = (controller.takeScreenshotAsync(0) as ScreenshotCaptureOutcome.Success).payload

    assertNull(payload.rotation)
  }

  @Test
  fun platformFailureKeepsTheErrorCode() = runTest {
    host.behavior = { it.onFailure(3) }

    assertEquals(ScreenshotCaptureOutcome.Failure(3), controller.takeScreenshotAsync(0))
  }

  @Test
  fun unwrappableBufferIsAFailureWithoutCode() = runTest {
    every { Bitmap.wrapHardwareBuffer(any<HardwareBuffer>(), any<ColorSpace>()) } returns null
    host.behavior = { it.onSuccess(screenshotResult()) }

    assertEquals(ScreenshotCaptureOutcome.Failure(null), controller.takeScreenshotAsync(0))
  }

  @Test
  fun hostExceptionBecomesAFailureWithoutCode() = runTest {
    host.behavior = { throw IllegalStateException("service unbound") }

    assertEquals(ScreenshotCaptureOutcome.Failure(null), controller.takeScreenshotAsync(0))
  }

  @Test
  fun cancellationIsRethrownNotConvertedToAFailure() = runTest {
    host.behavior = { throw CancellationException("caller cancelled") }

    try {
      controller.takeScreenshotAsync(0)
      throw AssertionError("expected CancellationException")
    } catch (expected: CancellationException) {
      assertEquals("caller cancelled", expected.message)
    }
  }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [26])
class ScreenshotControllerPreApi30Test {
  @Test
  fun belowApi30FailsWithoutCallingThePlatform() = runTest {
    var called = false
    val host =
      object : ScreenshotController.Host {
        override fun takeScreenshot(displayId: Int, callback: TakeScreenshotCallback) {
          called = true
        }

        override fun rotationProvenance(): RotationProvenanceTracker =
          error("rotation must not be read below API 30")
      }
    val controller =
      ScreenshotController(
        host,
        DisplayController(mockk(relaxed = true)),
        object : TimeProvider {
          override fun currentTimeMillis() = 0L
        },
      )

    assertEquals(ScreenshotCaptureOutcome.Failure(null), controller.takeScreenshotAsync(0))
    assertEquals(false, called)
  }
}
