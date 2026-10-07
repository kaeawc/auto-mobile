package dev.jasonpearson.automobile.ctrlproxy.overlay.screenshot

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.os.Looper
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import dev.jasonpearson.automobile.ctrlproxy.overlay.OverlaySpecContent
import dev.jasonpearson.automobile.ctrlproxy.overlay.mapOverlaySpec
import dev.jasonpearson.automobile.protocol.OverlaySpec
import dev.jasonpearson.automobile.protocol.OverlaySpecValidation
import dev.jasonpearson.automobile.protocol.OverlaySpecValidator
import java.io.File
import java.time.Duration
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf

/**
 * Lets Compose run its layout and draw frames on Robolectric's paused main looper. This advances
 * the fake looper clock only; no wall-clock time passes.
 */
private val SETTLE: Duration = Duration.ofSeconds(1)

/** Encodes PNGs through the platform codec, which Robolectric's native graphics mode provides. */
internal object BitmapPngCodec : OverlayScreenshotComparator.PngCodec {
  override fun read(file: File): OverlayScreenshotComparator.Image? =
    if (file.isFile) BitmapFactory.decodeFile(file.path)?.let(::toImage) else null

  override fun write(file: File, image: OverlayScreenshotComparator.Image) {
    val bitmap = Bitmap.createBitmap(image.width, image.height, Bitmap.Config.ARGB_8888)
    bitmap.setPixels(image.pixels, 0, image.width, 0, 0, image.width, image.height)
    file.parentFile?.mkdirs()
    file.outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
  }

  fun toImage(bitmap: Bitmap): OverlayScreenshotComparator.Image {
    val pixels = IntArray(bitmap.width * bitmap.height)
    bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
    return OverlayScreenshotComparator.Image(bitmap.width, bitmap.height, pixels)
  }
}

/** Loads a shared fixture from the repo's `test/fixtures/overlay-spec/valid` directory. */
internal fun validOverlayFixture(name: String): OverlaySpec {
  val file =
    generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
      .map { File(it, "test/fixtures/overlay-spec/valid/$name.json") }
      .first { it.isFile }
  val validation = OverlaySpecValidator.validate(file.readText())
  check(validation is OverlaySpecValidation.Success) { "$name: $validation" }
  return validation.spec
}

/**
 * Renders [spec] through the production [OverlaySpecContent] adapter in a Robolectric activity,
 * captures the composed view and records or verifies it against the baseline named [name].
 *
 * Must run under `RobolectricTestRunner` with `@GraphicsMode(NATIVE)`; the surface size and density
 * come from the test's `@Config(qualifiers = …)`. [pending] marks a test whose baseline is not
 * recorded yet: skipped when verifying, still produced when recording.
 */
internal fun overlayScreenshotTest(
  name: String,
  spec: OverlaySpec,
  pending: Boolean = false,
  options: OverlayScreenshotComparator.Options = OverlayScreenshotComparator.Options(),
) {
  OverlayScreenshotEnvironment.assumeReferencePlatform()
  OverlayScreenshotEnvironment.skipIfPending(name, pending)
  val root = mapOverlaySpec(spec).root
  val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
  try {
    val activity = controller.get()
    activity.setContent { OverlaySpecContent(root) }
    shadowOf(Looper.getMainLooper()).idleFor(SETTLE)
    val view = activity.findViewById<ViewGroup>(android.R.id.content).getChildAt(0)
    check(view.width > 0 && view.height > 0) { "$name: overlay view was not laid out" }
    val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
    view.draw(Canvas(bitmap))
    OverlayScreenshotEnvironment.handleResult(
      BitmapPngCodec,
      name,
      BitmapPngCodec.toImage(bitmap),
      options,
    )
  } finally {
    controller.pause().stop().destroy()
  }
}
