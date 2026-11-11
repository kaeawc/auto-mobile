package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Point
import android.hardware.display.DisplayManager
import android.os.Looper
import android.view.Display
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDisplayManager

/** Exercises the real window-context factory and DisplayManager removal signal. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w400dp-h600dp-mdpi")
class DisplayLogicalSizeReaderFactoryTest {
  private val context = RuntimeEnvironment.getApplication()
  private val displayManager = context.getSystemService(DisplayManager::class.java)
  private val reader = createDisplayLogicalSizeReader(context)

  @After
  fun tearDown() {
    reader.close()
  }

  private fun display(id: Int): Display = displayManager.getDisplay(id)

  @Test
  fun `reads the display's maximum window bounds through a cached window context`() {
    assertEquals(Point(400, 600), reader.read(display(Display.DEFAULT_DISPLAY)))
    assertEquals(Point(400, 600), reader.read(display(Display.DEFAULT_DISPLAY)))
    assertEquals(1, reader.cachedDisplayCount)
  }

  @Test
  fun `drops a secondary display's context when DisplayManager reports its removal`() {
    val secondaryId = ShadowDisplayManager.addDisplay("w300dp-h200dp-mdpi")
    // Robolectric's window context does not report a secondary display's own bounds; this test
    // covers eviction, so any positive read that populates the cache is enough.
    assertNotNull(reader.read(display(secondaryId)))
    assertEquals(1, reader.cachedDisplayCount)

    ShadowDisplayManager.removeDisplay(secondaryId)
    shadowOf(Looper.getMainLooper()).idle()

    assertEquals(0, reader.cachedDisplayCount)
    assertNull(displayManager.getDisplay(secondaryId))
  }
}
