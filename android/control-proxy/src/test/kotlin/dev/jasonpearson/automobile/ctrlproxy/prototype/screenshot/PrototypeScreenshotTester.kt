package dev.jasonpearson.automobile.ctrlproxy.prototype.screenshot

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.os.Looper
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeSpecContent
import dev.jasonpearson.automobile.ctrlproxy.prototype.mapPrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidation
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
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
internal object BitmapPngCodec : PrototypeScreenshotComparator.PngCodec {
  override fun read(file: File): PrototypeScreenshotComparator.Image? =
    if (file.isFile) BitmapFactory.decodeFile(file.path)?.let(::toImage) else null

  override fun write(file: File, image: PrototypeScreenshotComparator.Image) {
    val bitmap = Bitmap.createBitmap(image.width, image.height, Bitmap.Config.ARGB_8888)
    bitmap.setPixels(image.pixels, 0, image.width, 0, 0, image.width, image.height)
    file.parentFile?.mkdirs()
    file.outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
  }

  fun toImage(bitmap: Bitmap): PrototypeScreenshotComparator.Image {
    val pixels = IntArray(bitmap.width * bitmap.height)
    bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
    return PrototypeScreenshotComparator.Image(bitmap.width, bitmap.height, pixels)
  }
}

/**
 * Loads a shared fixture from the repo's `test/fixtures/prototype-spec/valid` directory. With
 * [resolveElementAnchors] each `element` anchor is replaced by a fixed `bounds` anchor with the
 * same alignment (and offset), standing in for the host's selector resolution: the renderer refuses
 * an unresolved element anchor.
 */
internal fun validPrototypeFixture(
  name: String,
  resolveElementAnchors: Boolean = false,
  stateOverrides: Map<String, JsonElement> = emptyMap(),
): PrototypeSpec {
  val file =
    generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
      .map { File(it, "test/fixtures/prototype-spec/valid/$name.json") }
      .first { it.isFile }
  if (!resolveElementAnchors && stateOverrides.isEmpty()) return loadPrototypeSpec(file)
  var edited = Json.parseToJsonElement(file.readText())
  if (resolveElementAnchors) edited = resolveElementAnchors(edited)
  if (stateOverrides.isNotEmpty()) edited = overrideInitialState(edited, stateOverrides)
  return loadPrototypeSpecText(file.path, Json.encodeToString(JsonElement.serializer(), edited))
}

/**
 * Replaces keys of the spec's initial `state`, so a gallery case can open a dialog or bottom sheet
 * that the shared fixture authors closed. Only keys the fixture already declares may be set.
 */
private fun overrideInitialState(
  spec: JsonElement,
  overrides: Map<String, JsonElement>,
): JsonElement {
  val root = spec as JsonObject
  val state = root["state"] as JsonObject
  val unknown = overrides.keys - state.keys
  check(unknown.isEmpty()) { "fixture state has no keys $unknown" }
  return JsonObject(root + ("state" to JsonObject(state + overrides)))
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

/** Reads [file] and validates it with the production [PrototypeSpecValidator]. */
internal fun loadPrototypeSpec(file: File): PrototypeSpec {
  check(file.isFile) { "Prototype spec not found: ${file.path}" }
  return loadPrototypeSpecText(file.path, file.readText())
}

private fun loadPrototypeSpecText(source: String, text: String): PrototypeSpec {
  val validation = PrototypeSpecValidator.validate(text)
  check(validation is PrototypeSpecValidation.Success) { "$source: $validation" }
  return validation.spec
}

/**
 * Renders [spec] through the production [PrototypeSpecContent] adapter in a Robolectric activity
 * and captures the composed view. Shared by the snapshot tests and the host-side preview
 * ([PrototypePreviewRenderTest]) so both draw exactly what the renderer draws.
 *
 * Must run under `RobolectricTestRunner` with `@GraphicsMode(NATIVE)`; the surface size, density
 * and night mode come from the current Robolectric qualifiers.
 */
internal fun renderPrototype(
  name: String,
  spec: PrototypeSpec,
): PrototypeScreenshotComparator.Image {
  val model = mapPrototypeSpec(spec)
  // The spec's own theme must reach the renderer, as it does in the live prototype host.
  return renderComposable(name) { PrototypeSpecContent(model.root, theme = model.theme) }
}

/**
 * Draws [content] in a Robolectric activity and captures the composed view. Shared by
 * [renderPrototype] and the host-chrome screenshot test.
 */
internal fun renderComposable(
  name: String,
  content: @Composable () -> Unit,
): PrototypeScreenshotComparator.Image {
  val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
  try {
    val activity = controller.get()
    activity.setContent(content = content)
    shadowOf(Looper.getMainLooper()).idleFor(SETTLE)
    val view = activity.findViewById<ViewGroup>(android.R.id.content).getChildAt(0)
    check(view.width > 0 && view.height > 0) { "$name: prototype view was not laid out" }
    val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
    view.draw(Canvas(bitmap))
    return BitmapPngCodec.toImage(bitmap)
  } finally {
    controller.pause().stop().destroy()
  }
}

/**
 * Renders [spec] with [renderPrototype] and records or verifies it against the baseline named
 * [name]. [pending] marks a test whose baseline is not recorded yet: skipped when verifying, still
 * produced when recording.
 */
internal fun prototypeScreenshotTest(
  name: String,
  spec: PrototypeSpec,
  pending: Boolean = false,
  options: PrototypeScreenshotComparator.Options = PrototypeScreenshotComparator.Options(),
) {
  PrototypeScreenshotEnvironment.assumeReferencePlatform()
  PrototypeScreenshotEnvironment.skipIfPending(name, pending)
  PrototypeScreenshotEnvironment.handleResult(
    BitmapPngCodec,
    name,
    renderPrototype(name, spec),
    options,
  )
}
