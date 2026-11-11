package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Point
import android.graphics.Rect
import android.os.Build
import android.view.Display
import android.view.WindowManager
import io.mockk.every
import io.mockk.mockk
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DisplayLogicalSizeReaderTest {
  private class FakeRemovalSignal(private val available: Boolean = true) : DisplayRemovalSignal {
    var registrations = 0
      private set

    var closes = 0
      private set

    var onRemoved: ((Int) -> Unit)? = null
      private set

    override fun register(onRemoved: (Int) -> Unit): AutoCloseable? {
      registrations++
      if (!available) return null
      this.onRemoved = onRemoved
      return AutoCloseable {
        closes++
        this.onRemoved = null
      }
    }
  }

  private class FakeWindowManagers(var width: Int = 2560, var height: Int = 2558) {
    val created = mutableListOf<Int>()
    var createFailure: RuntimeException? = null
    var metricsFailure: RuntimeException? = null

    fun create(display: Display): WindowManager {
      createFailure?.let { throw it }
      created += display.displayId
      return mockk {
        every { maximumWindowMetrics } answers
          {
            metricsFailure?.let { throw it }
            mockk { every { bounds } returns Rect(0, 0, width, height) }
          }
      }
    }
  }

  private fun display(id: Int): Display = mockk { every { displayId } returns id }

  private fun reader(
    windowManagers: FakeWindowManagers,
    signal: DisplayRemovalSignal,
    sdkInt: Int = Build.VERSION_CODES.UPSIDE_DOWN_CAKE,
  ) = CachingDisplayLogicalSizeReader(windowManagers::create, signal) { sdkInt }

  @Test
  fun `reuses one window context per display`() {
    val windowManagers = FakeWindowManagers()
    val signal = FakeRemovalSignal()
    val reader = reader(windowManagers, signal)

    assertEquals(Point(2560, 2558), reader.read(display(0)))
    windowManagers.width = 1920
    windowManagers.height = 1080
    assertEquals(Point(2560, 2558), reader.read(display(0)))
    assertEquals(Point(1920, 1080), reader.read(display(3)))

    assertEquals(listOf(0, 3), windowManagers.created)
    assertEquals(2, reader.cachedDisplayCount)
    assertEquals(1, signal.registrations)
  }

  @Test
  fun `registers for display removal only on first cached read`() {
    val signal = FakeRemovalSignal()
    val reader = reader(FakeWindowManagers(), signal)

    assertEquals(0, signal.registrations)
    reader.read(display(0))
    assertEquals(1, signal.registrations)
  }

  @Test
  fun `drops the cached context when its display is removed`() {
    val windowManagers = FakeWindowManagers()
    val signal = FakeRemovalSignal()
    val reader = reader(windowManagers, signal)
    reader.read(display(0))
    reader.read(display(3))

    signal.onRemoved?.invoke(3)

    assertEquals(1, reader.cachedDisplayCount)
    reader.read(display(3))
    assertEquals(listOf(0, 3, 3), windowManagers.created)
  }

  @Test
  fun `creates a context per read when removals cannot be observed`() {
    val windowManagers = FakeWindowManagers()
    val signal = FakeRemovalSignal(available = false)
    val reader = reader(windowManagers, signal)

    assertEquals(Point(2560, 2558), reader.read(display(0)))
    assertEquals(Point(2560, 2558), reader.read(display(0)))

    assertEquals(listOf(0, 0), windowManagers.created)
    assertEquals(0, reader.cachedDisplayCount)
    assertEquals(1, signal.registrations)
  }

  @Test
  fun `returns null for any runtime failure while creating the context`() {
    val windowManagers = FakeWindowManagers()
    val reader = reader(windowManagers, FakeRemovalSignal())

    listOf(
        IllegalArgumentException("bad display"),
        UnsupportedOperationException("unsupported"),
        SecurityException("denied"),
        IllegalStateException("not attached"),
        RuntimeException("binder died"),
      )
      .forEach { failure ->
        windowManagers.createFailure = failure
        assertNull(reader.read(display(0)))
      }
    assertEquals(0, reader.cachedDisplayCount)
  }

  @Test
  fun `evicts a cached context whose metrics read fails and rebuilds it next read`() {
    val windowManagers = FakeWindowManagers()
    val reader = reader(windowManagers, FakeRemovalSignal())
    reader.read(display(0))

    windowManagers.metricsFailure = RuntimeException("dead window token")
    assertNull(reader.read(display(0)))
    assertEquals(0, reader.cachedDisplayCount)

    windowManagers.metricsFailure = null
    assertEquals(Point(2560, 2558), reader.read(display(0)))
    assertEquals(listOf(0, 0), windowManagers.created)
  }

  @Test(expected = kotlinx.coroutines.CancellationException::class)
  fun `does not swallow cancellation`() {
    val windowManagers = FakeWindowManagers()
    windowManagers.createFailure = kotlinx.coroutines.CancellationException("cancelled")
    reader(windowManagers, FakeRemovalSignal()).read(display(0))
  }

  @Test
  fun `returns null for non-positive bounds`() {
    val reader = reader(FakeWindowManagers(width = 0, height = 2558), FakeRemovalSignal())

    assertNull(reader.read(display(0)))
  }

  @Test
  fun `returns null below API 31 without creating a context`() {
    val windowManagers = FakeWindowManagers()
    val signal = FakeRemovalSignal()
    val reader = reader(windowManagers, signal, sdkInt = Build.VERSION_CODES.R)

    assertNull(reader.read(display(0)))
    assertTrue(windowManagers.created.isEmpty())
    assertEquals(0, signal.registrations)
  }

  @Test
  fun `close releases the removal listener and stops caching`() {
    val windowManagers = FakeWindowManagers()
    val signal = FakeRemovalSignal()
    val reader = reader(windowManagers, signal)
    reader.read(display(0))

    reader.close()

    assertEquals(1, signal.closes)
    assertEquals(0, reader.cachedDisplayCount)
    assertEquals(Point(2560, 2558), reader.read(display(0)))
    assertEquals(0, reader.cachedDisplayCount)
    assertEquals(1, signal.registrations)
  }
}
