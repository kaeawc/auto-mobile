package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.double
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * A literal list template: the container's children are instantiated once per [items] entry, with
 * `{as.field}` and `{index}` bound per instance. Each item maps field names to scalar values.
 */
@Serializable(with = PrototypeRepeatSerializer::class)
data class PrototypeRepeat(
  val items: List<Map<String, PrototypeScalar>>,
  val `as`: String,
  val itemsPath: String? = null,
  val key: String? = null,
  val derive: Map<String, PrototypeDerivedEntry>? = null,
  val stagger: Int? = null,
)

@Serializable
private data class PrototypeRepeatWire(
  val items: JsonElement,
  val `as`: String,
  val key: String? = null,
  val derive: Map<String, PrototypeDerivedEntry>? = null,
  val stagger: Int? = null,
)

/** Keeps the source pointer in `items.path`, never as a wire-level `itemsPath` member. */
object PrototypeRepeatSerializer :
  PrototypeJsonValueSerializer<PrototypeRepeat>("PrototypeRepeat") {
  override fun fromJson(value: JsonElement): PrototypeRepeat {
    val json = PrototypeSpecValidator.json
    val wire = json.decodeFromJsonElement<PrototypeRepeatWire>(value)
    val source = wire.items as? JsonObject
    val pointer = source?.get("path") as? JsonPrimitive
    if (source != null && (source.keys != setOf("path") || pointer?.isString != true)) {
      throw kotlinx.serialization.SerializationException("Expected repeat path")
    }
    val items =
      if (source == null) json.decodeFromJsonElement<List<Map<String, PrototypeScalar>>>(wire.items)
      else emptyList()
    return PrototypeRepeat(items, wire.`as`, pointer?.content, wire.key, wire.derive, wire.stagger)
  }

  override fun toJson(value: PrototypeRepeat): JsonElement {
    val json = PrototypeSpecValidator.json
    val items =
      value.itemsPath?.let { buildJsonObject { put("path", it) } }
        ?: json.encodeToJsonElement(value.items)
    return json.encodeToJsonElement(
      PrototypeRepeatWire(items, value.`as`, value.key, value.derive, value.stagger),
    )
  }
}

/**
 * One swipe-revealed button: [label] is its text and accessibility name, [role] `destructive`
 * selects error colours, [color] (hex or theme role) overrides the background.
 */
@Serializable
data class PrototypeSwipeAction(
  val label: String,
  val icon: String? = null,
  val role: String? = null,
  val color: String? = null,
  val onTap: List<PrototypeAction>,
)

/**
 * `start` is revealed by a right swipe, `end` by a left swipe; [fullSwipe] runs the first entry.
 */
@Serializable
data class PrototypeSwipeActions(
  val start: List<PrototypeSwipeAction>? = null,
  val end: List<PrototypeSwipeAction>? = null,
  val fullSwipe: Boolean? = null,
)

/** Fixed column count or adaptive minimum cell width in dp; preserves the untagged wire union. */
@Serializable(with = PrototypeGridColumnsSerializer::class)
sealed class PrototypeGridColumns {
  data class Fixed(val count: Int) : PrototypeGridColumns()

  data class Adaptive(val minWidth: Double) : PrototypeGridColumns()
}

object PrototypeGridColumnsSerializer :
  PrototypeJsonValueSerializer<PrototypeGridColumns>("PrototypeGridColumns") {
  private fun isColumnCount(count: Double): Boolean =
    count.isFinite() && count in 1.0..Int.MAX_VALUE.toDouble() && count % 1.0 == 0.0

  override fun fromJson(value: JsonElement): PrototypeGridColumns {
    if (value is JsonPrimitive && !value.isString) {
      val count = value.doubleOrNull
      if (count != null && isColumnCount(count)) {
        return PrototypeGridColumns.Fixed(count.toInt())
      }
    }
    if (value is JsonObject && value.keys == setOf("minWidth")) {
      val width = (value["minWidth"] as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull
      if (width != null && width.isFinite() && width > 0)
        return PrototypeGridColumns.Adaptive(width)
    }
    throw kotlinx.serialization.SerializationException("Expected grid columns")
  }

  override fun toJson(value: PrototypeGridColumns): JsonElement =
    when (value) {
      is PrototypeGridColumns.Fixed -> JsonPrimitive(value.count)
      is PrototypeGridColumns.Adaptive -> buildJsonObject { put("minWidth", value.minWidth) }
    }
}

/**
 * `linkify` on a text node: the [kinds] to detect, the [style] of a match and the actions a tap
 * runs. [onTap] stays JSON because its `{match}` bindings are bound per match before decoding
 * ([PrototypeLinkify.actions]).
 */
@Serializable
data class PrototypeLinkifyOptions(
  val kinds: List<String>,
  val style: PrototypeTextSpanStyle? = null,
  val onTap: JsonArray,
)

@Serializable
data class PrototypeTextSpan(
  val text: String,
  val style: PrototypeTextSpanStyle? = null,
  val onTap: List<PrototypeAction>? = null,
)

@Serializable
data class PrototypeTextSpanStyle(
  val color: PrototypeModeValue? = null,
  val fontWeight: Int? = null,
  val fontStyle: String? = null,
  val textDecoration: String? = null,
  val textSize: Double? = null,
  val letterSpacing: Double? = null,
  val fontFamily: PrototypeFontFamily? = null,
  val background: PrototypeModeValue? = null,
)

/**
 * The displayed text, with each authored text field resolved by the same caller-supplied binder.
 */
fun prototypePlainText(node: PrototypeTextNode, resolve: (String) -> String = { it }): String =
  node.spans?.joinToString("") { resolve(it.text) } ?: node.text?.let(resolve).orEmpty()

/** Menu entries have no discriminator; only a divider carries `type`. */
@Serializable(with = PrototypeMenuItemSerializer::class) sealed class PrototypeMenuItem

@Serializable
data class PrototypeMenuEntry(
  val label: String,
  val icon: String? = null,
  val trailingText: String? = null,
  val enabled: Boolean? = null,
  val onTap: List<PrototypeAction>? = null,
) : PrototypeMenuItem()

data object PrototypeMenuDivider : PrototypeMenuItem()

object PrototypeMenuItemSerializer :
  PrototypeJsonValueSerializer<PrototypeMenuItem>("PrototypeMenuItem") {
  override fun fromJson(value: JsonElement): PrototypeMenuItem {
    if (value is JsonObject && value["type"] == JsonPrimitive("divider")) {
      require(value.keys == setOf("type")) { "Unknown property" }
      return PrototypeMenuDivider
    }
    return PrototypeSpecValidator.json.decodeFromJsonElement<PrototypeMenuEntry>(value)
  }

  override fun toJson(value: PrototypeMenuItem): JsonElement =
    when (value) {
      is PrototypeMenuEntry -> PrototypeSpecValidator.json.encodeToJsonElement(value)
      PrototypeMenuDivider -> buildJsonObject { put("type", "divider") }
    }
}

/** One chart series: the `/data` array at [path], its points' [y] and optional [x] members. */
@Serializable
data class PrototypeChartSeries(
  val path: String,
  val x: String? = null,
  val y: String,
  val label: String,
  val color: PrototypeModeValue? = null,
)

@Serializable data class PrototypePagerPeek(val start: Double? = null, val end: Double? = null)

@Serializable
data class PrototypeWindow(
  val placement: PrototypePlacement,
  val opacity: Int = 100,
  /**
   * `system` (default when absent) stacks above system UI as an accessibility overlay; `app` stacks
   * just above apps, below the shade, keyboard and screenshot preview, and needs
   * SYSTEM_ALERT_WINDOW.
   */
  val layer: String? = null,
  /**
   * `session` (default when absent) ends the prototype with its host session; `device` keeps it
   * interactive after the last client disconnects and disables the idle timeout.
   */
  val persistence: String? = null,
  /** Fullscreen host chrome: `none` by default, or `bar`; device persistence defaults to `bar`. */
  val chrome: String? = null,
  /** Opt-in window-local dead-tap events; coordinates never include field contents. */
  val deadTaps: Boolean? = null,
  /** Blur or tonal fill behind the window (`prototype_backdrop_v1`, #15126). */
  val backdrop: PrototypeBackdrop? = null,
  val transition: String? = null,
)

/**
 * `source = "device"` asks for Android 12+ dynamic colour; `seed` generates a scheme from one
 * colour. Each Material 3 role field is an explicit hex override applied over that scheme (or the
 * baseline one) in both light and dark. `light` and `dark` are `{role: hex}` maps applied after
 * those flat overrides for the resolved mode only (#11218); they never drive mode inference.
 */
@Serializable
data class PrototypeSpecThemeColors(
  val seed: String? = null,
  val source: String? = null,
  val primary: String? = null,
  val onPrimary: String? = null,
  val primaryContainer: String? = null,
  val onPrimaryContainer: String? = null,
  val inversePrimary: String? = null,
  val secondary: String? = null,
  val onSecondary: String? = null,
  val secondaryContainer: String? = null,
  val onSecondaryContainer: String? = null,
  val tertiary: String? = null,
  val onTertiary: String? = null,
  val tertiaryContainer: String? = null,
  val onTertiaryContainer: String? = null,
  val background: String? = null,
  val onBackground: String? = null,
  val surface: String? = null,
  val onSurface: String? = null,
  val surfaceVariant: String? = null,
  val onSurfaceVariant: String? = null,
  val surfaceTint: String? = null,
  val inverseSurface: String? = null,
  val inverseOnSurface: String? = null,
  val error: String? = null,
  val onError: String? = null,
  val errorContainer: String? = null,
  val onErrorContainer: String? = null,
  val outline: String? = null,
  val outlineVariant: String? = null,
  val scrim: String? = null,
  val surfaceBright: String? = null,
  val surfaceDim: String? = null,
  val surfaceContainer: String? = null,
  val surfaceContainerHigh: String? = null,
  val surfaceContainerHighest: String? = null,
  val surfaceContainerLow: String? = null,
  val surfaceContainerLowest: String? = null,
  val light: Map<String, String>? = null,
  val dark: Map<String, String>? = null,
)

/** `scale` multiplies every Material type role; `fontFamily` is sans, serif or mono. */
@Serializable
data class PrototypeSpecThemeTypography(
  val scale: Double? = null,
  val fontFamily: String? = null,
)

/** `corner` picks one of the Material corner families (none, small, medium, large, full). */
@Serializable data class PrototypeSpecThemeShapes(val corner: String? = null)

@Serializable
data class PrototypeSpecTheme(
  val mode: String? = null,
  val colors: PrototypeSpecThemeColors? = null,
  val typography: PrototypeSpecThemeTypography? = null,
  val shapes: PrototypeSpecThemeShapes? = null,
  val design: String? = null,
)

@Serializable
data class PrototypeSpec(
  val id: String,
  val window: PrototypeWindow,
  val state: Map<String, PrototypeScalar>? = null,
  val root: PrototypeNode,
  val theme: PrototypeSpecTheme? = null,
  /**
   * `none` is instant; `reduced` keeps fades/colors and snaps spatial motion; `expressive` uses
   * Material expressive springs. Standard follows system scales.
   */
  val motion: String? = null,
  val data: JsonObject? = null,
  val derive: Map<String, PrototypeDerivedEntry>? = null,
  /** The state keys and `/data` pointers the device keeps across shows (#12522). */
  val storage: PrototypeStorageBlock? = null,
  /** What the spec needs from the platform before show (#14294). */
  val requires: PrototypeRequires? = null,
  /** `platform.on`: action lists run when a platform event is delivered (#14294). */
  val platform: PrototypePlatformHandlers? = null,
  /** Validated channel declarations; no transport is installed by the contract slice. */
  val channels: Map<String, PrototypeChannel>? = null,
  val strings: JsonObject? = null,
)

/** The root `requires` block (#14294): platform modules, permissions and background needs. */
@Serializable
data class PrototypeRequires(
  val platform: List<String>? = null,
  val permissions: List<PrototypePermissionRequirement>? = null,
  val background: List<String>? = null,
)

/** One declared permission: a canonical [name] and the [purpose] shown to the user. */
@Serializable data class PrototypePermissionRequirement(val name: String, val purpose: String)

/** Root `platform`: action lists keyed by `<module>.<event>`. */
@Serializable data class PrototypePlatformHandlers(val on: Map<String, List<PrototypeAction>>)

@Serializable
enum class PrototypeValidateOn {
  @SerialName("change") CHANGE,
  @SerialName("blur") BLUR,
  @SerialName("submit") SUBMIT,
}

@Serializable
enum class PrototypeCheckFormat {
  @SerialName("email") EMAIL,
  @SerialName("phone") PHONE,
  @SerialName("digits") DIGITS,
  @SerialName("decimal") DECIMAL,
  @SerialName("url") URL,
}

/** The untagged wire union preserves the authored check kind and message. */
@Serializable(with = PrototypeCheckSerializer::class)
sealed class PrototypeCheck {
  abstract val message: String

  data class Required(override val message: String, val required: Boolean = true) : PrototypeCheck()

  data class MinLength(val minLength: Double, override val message: String) : PrototypeCheck()

  data class MaxLength(val maxLength: Double, override val message: String) : PrototypeCheck()

  data class Min(val min: Double, override val message: String) : PrototypeCheck()

  data class Max(val max: Double, override val message: String) : PrototypeCheck()

  data class Format(val format: PrototypeCheckFormat, override val message: String) :
    PrototypeCheck()

  data class Pattern(val pattern: String, override val message: String) : PrototypeCheck()
}

object PrototypeCheckSerializer : PrototypeJsonValueSerializer<PrototypeCheck>("PrototypeCheck") {
  override fun fromJson(value: JsonElement): PrototypeCheck {
    val data = value.jsonObject
    val message = data.getValue("message").jsonPrimitive.content
    val kind = data.keys.single { it != "message" }
    val operand = data.getValue(kind).jsonPrimitive
    return when (kind) {
      "required" -> PrototypeCheck.Required(message, operand.boolean)
      "minLength" -> PrototypeCheck.MinLength(operand.double, message)
      "maxLength" -> PrototypeCheck.MaxLength(operand.double, message)
      "min" -> PrototypeCheck.Min(operand.double, message)
      "max" -> PrototypeCheck.Max(operand.double, message)
      "format" ->
        PrototypeCheck.Format(PrototypeSpecValidator.json.decodeFromJsonElement(operand), message)
      "pattern" -> PrototypeCheck.Pattern(operand.content, message)
      else -> throw kotlinx.serialization.SerializationException("Unknown check kind")
    }
  }

  override fun toJson(value: PrototypeCheck): JsonElement = buildJsonObject {
    put("message", value.message)
    when (value) {
      is PrototypeCheck.Required -> put("required", value.required)
      is PrototypeCheck.MinLength -> put("minLength", value.minLength)
      is PrototypeCheck.MaxLength -> put("maxLength", value.maxLength)
      is PrototypeCheck.Min -> put("min", value.min)
      is PrototypeCheck.Max -> put("max", value.max)
      is PrototypeCheck.Format ->
        put("format", PrototypeSpecValidator.json.encodeToJsonElement(value.format))
      is PrototypeCheck.Pattern -> put("pattern", value.pattern)
    }
  }
}

/** A single checked key or an authored list; round trips retain the selected wire form. */
@Serializable(with = PrototypeValidityKeysSerializer::class)
sealed class PrototypeValidityKeys {
  data class Single(val key: String) : PrototypeValidityKeys()

  data class Multiple(val keys: List<String>) : PrototypeValidityKeys()

  fun keys(): List<String> =
    when (this) {
      is Single -> listOf(key)
      is Multiple -> keys
    }
}

object PrototypeValidityKeysSerializer :
  PrototypeJsonValueSerializer<PrototypeValidityKeys>("PrototypeValidityKeys") {
  override fun fromJson(value: JsonElement): PrototypeValidityKeys =
    when (value) {
      is JsonArray -> PrototypeValidityKeys.Multiple(value.map { it.jsonPrimitive.content })
      else -> PrototypeValidityKeys.Single(value.jsonPrimitive.content)
    }

  override fun toJson(value: PrototypeValidityKeys): JsonElement =
    when (value) {
      is PrototypeValidityKeys.Single -> JsonPrimitive(value.key)
      is PrototypeValidityKeys.Multiple -> JsonArray(value.keys.map(::JsonPrimitive))
    }
}

@SerialName("pasteButton")
@Serializable
data class PrototypePasteButtonNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  override val semantics: PrototypeSemantics? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val press: PrototypePress? = null,
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val keyframes: JsonObject? = null,
  val into: String,
) : PrototypeNode() {
  override val onTap: List<PrototypeAction>
    get() = listOf(PrototypePlatformAction(call = "clipboard.paste", into = into))
}
