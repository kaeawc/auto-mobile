package dev.jasonpearson.automobile.protoviewer

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Same native Canvas capture path as the existing Android screenshot harness, without goldens. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h640dp-mdpi")
class LibraryScreenshotTest {
  @get:Rule val compose = createComposeRule()

  @Test
  fun emptyLibraryDrawsVisibleChromeAndEmptyState() {
    ApplicationProvider.getApplicationContext<ProtoViewerApplication>().servicesFactory = {
      ProtoViewerServices(
        FakeLibraryRepository(),
        LibraryStorage(FakePrototypeStorage()),
        UnconfinedTestDispatcher(),
        LibraryClock { 42 },
        settings = FakeSettingsStore(),
      )
    }
    val controller = Robolectric.buildActivity(LibraryActivity::class.java).setup()
    try {
      compose.waitForIdle()
      val view = controller.get().window.decorView
      val image = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
      view.draw(Canvas(image))
      val pixels = IntArray(image.width * image.height)
      image.getPixels(pixels, 0, image.width, 0, 0, image.width, image.height)
      // Capture must contain both the opaque Material surface and foreground glyphs.
      assertTrue(pixels.any { it ushr 24 == 255 })
      assertTrue(pixels.toSet().size > 2)
      image.recycle()
    } finally {
      controller.pause().stop().destroy()
    }
  }
}
