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
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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

/**
 * Loads a shared fixture from the repo's `test/fixtures/overlay-spec/valid` directory. With
 * [resolveElementAnchors] each `element` anchor is replaced by a fixed `bounds` anchor with the
 * same alignment (and offset), standing in for the host's selector resolution: the renderer refuses
 * an unresolved element anchor.
 */
internal fun validOverlayFixture(
  name: String,
  resolveElementAnchors: Boolean = false,
): OverlaySpec {
  val file =
    generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
      .map { File(it, "test/fixtures/overlay-spec/valid/$name.json") }
      .first { it.isFile }
  if (!resolveElementAnchors) return loadOverlaySpec(file)
  val resolved = resolveElementAnchors(Json.parseToJsonElement(file.readText()))
  return loadOverlaySpecText(file.path, Json.encodeToString(JsonElement.serializer(), resolved))
}

private val RESOLVED_BOUNDS =
  JsonObject(
    mapOf(
      "x" to JsonPrimitive(24),
      "y" to JsonPrimitive(120),
      "width" to JsonPrimitive(160),
      "height" to JsonPrimitive(48),
    ),
  )

private fun resolveElementAnchors(element: JsonElement): JsonElement =
  when (element) {
    is JsonArray -> JsonArray(element.map(::resolveElementAnchors))
    is JsonObject ->
      if ((element["type"] as? JsonPrimitive)?.content == "element" && "selector" in element) {
        JsonObject(
          element.filterKeys { it != "selector" } +
            mapOf("type" to JsonPrimitive("bounds"), "bounds" to RESOLVED_BOUNDS),
        )
      } else {
        JsonObject(element.mapValues { resolveElementAnchors(it.value) })
      }
    else -> element
  }

/** Reads [file] and validates it with the production [OverlaySpecValidator]. */
internal fun loadOverlaySpec(file: File): OverlaySpec {
  check(file.isFile) { "Overlay spec not found: ${file.path}" }
  return loadOverlaySpecText(file.path, file.readText())
}

private fun loadOverlaySpecText(source: String, text: String): OverlaySpec {
  val validation = OverlaySpecValidator.validate(text)
  check(validation is OverlaySpecValidation.Success) { "$source: $validation" }
  return validation.spec
}

/**
 * Renders [spec] through the production [OverlaySpecContent] adapter in a Robolectric activity and
 * captures the composed view. Shared by the snapshot tests and the host-side preview
 * ([OverlayPreviewRenderTest]) so both draw exactly what the renderer draws.
 *
 * Must run under `RobolectricTestRunner` with `@GraphicsMode(NATIVE)`; the surface size, density
 * and night mode come from the current Robolectric qualifiers.
 */
internal fun renderOverlay(name: String, spec: OverlaySpec): OverlayScreenshotComparator.Image {
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
    return BitmapPngCodec.toImage(bitmap)
  } finally {
    controller.pause().stop().destroy()
  }
}

/**
 * Renders [spec] with [renderOverlay] and records or verifies it against the baseline named [name].
 * [pending] marks a test whose baseline is not recorded yet: skipped when verifying, still produced
 * when recording.
 */
internal fun overlayScreenshotTest(
  name: String,
  spec: OverlaySpec,
  pending: Boolean = false,
  options: OverlayScreenshotComparator.Options = OverlayScreenshotComparator.Options(),
) {
  OverlayScreenshotEnvironment.assumeReferencePlatform()
  OverlayScreenshotEnvironment.skipIfPending(name, pending)
  OverlayScreenshotEnvironment.handleResult(
    BitmapPngCodec,
    name,
    renderOverlay(name, spec),
    options,
  )
}
