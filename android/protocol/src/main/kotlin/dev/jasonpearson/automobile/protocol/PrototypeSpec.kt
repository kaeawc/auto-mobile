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

@Serializable
data class PrototypeCondition(
  val key: String? = null,
  val equals: PrototypeScalar? = null,
  val notEquals: PrototypeScalar? = null,
  val gt: Double? = null,
  val lt: Double? = null,
  val all: List<PrototypeCondition>? = null,
  val any: List<PrototypeCondition>? = null,
  val not: PrototypeCondition? = null,
  val data: String? = null,
  /** A `/platform` pointer (#14294); platform state is device-owned and read-only. */
  val platform: String? = null,
  val valid: PrototypeValidityKeys? = null,
  /** With [data]: holds when that value is missing, `[]`, `{}` or `""` (#14207). */
  val empty: Boolean? = null,
)

@Serializable
data class PrototypeBorder(
  val width: Double,
  val color: PrototypeModeValue? = null,
  val gradient: PrototypeGradient? = null,
) {
  constructor(width: Double, color: String) : this(width, PrototypeModeValue.Single(color))
}

@Serializable
data class PrototypeGradientStop(
  val color: PrototypeModeValue,
  val position: Double? = null,
) {
  constructor(
    color: String,
    position: Double? = null,
  ) : this(PrototypeModeValue.Single(color), position)
}

@Serializable
data class PrototypeStyle(
  val width: PrototypeDimension? = null,
  val height: PrototypeDimension? = null,
  val weight: Double? = null,
  val minWidth: Double? = null,
  val maxWidth: Double? = null,
  val minHeight: Double? = null,
  val maxHeight: Double? = null,
  val padding: PrototypePadding? = null,
  /** Hex, colour role, or a `{light, dark}` pair of either, as every colour slot (#11218). */
  val background: PrototypeModeValue? = null,
  /** A dp number, a Material Shapes token, or per-corner dp radii. */
  val cornerRadius: PrototypeCornerRadius? = null,
  val border: PrototypeBorder? = null,
  val elevation: Double? = null,
  /** Hex or colour role tinting the `elevation` shadow; absent keeps the platform shadow colour. */
  val shadowColor: PrototypeModeValue? = null,
  val shadows: List<PrototypeShadow>? = null,
  val cornerStyle: String? = null,
  val gradient: PrototypeGradient? = null,
  val aspectRatio: Double? = null,
  /** A dp draw offset; it moves the drawn and touchable node without changing its layout slot. */
  val offset: PrototypeOffset? = null,
  val alpha: Double? = null,
  /** Scale (0.5-1) a tappable node shrinks to while pressed; absent leaves it unscaled. */
  val pressScale: Double? = null,
  /** An animated highlight sweep over a loading placeholder's background (#14207). */
  val shimmer: Boolean? = null,
  /** A drawn scale (0-4) about the node's centre; absent is 1 (#14208). */
  val scale: Double? = null,
  /** A drawn rotation in degrees (-360..360) about the node's centre (#14208). */
  val rotation: Double? = null,
  /**
   * Paint-only looks applied in order (#15128): `{type, ...params, animate?, phase?}` objects the
   * structural contract has already validated. Gated by `prototype_effects_v1`; a renderer decodes
   * the entries it draws, so the model keeps them as raw objects.
   */
  val effects: List<JsonObject>? = null,
  val alignment: String? = null,
  val arrangement: String? = null,
  val spacing: Double? = null,
  val runSpacing: Double? = null,
  val textSize: Double? = null,
  val fontWeight: Int? = null,
  val color: PrototypeModeValue? = null,
  val textAlign: String? = null,
  val maxLines: Int? = null,
  /** Positive sp between baselines. */
  val lineHeight: Double? = null,
  /** sp added between letters; negative tightens. */
  val letterSpacing: Double? = null,
  /** `none`, `underline`, `lineThrough` or `underlineLineThrough`. */
  val textDecoration: String? = null,
  /** `normal` or `italic`. */
  val fontStyle: String? = null,
  /** How text past `maxLines` or its width ends: `clip` (default), `ellipsis` or `visible`. */
  val overflow: String? = null,
  val fontFamily: PrototypeFontFamily? = null,
  /** A Material 3 type role (`titleLarge`, ...); explicit size, weight and family still win. */
  val textStyle: String? = null,
)

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
)

@Serializable
private data class PrototypeRepeatWire(
  val items: JsonElement,
  val `as`: String,
  val key: String? = null,
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
    return PrototypeRepeat(items, wire.`as`, pointer?.content, wire.key)
  }

  override fun toJson(value: PrototypeRepeat): JsonElement {
    val json = PrototypeSpecValidator.json
    val items =
      value.itemsPath?.let { buildJsonObject { put("path", it) } }
        ?: json.encodeToJsonElement(value.items)
    return json.encodeToJsonElement(PrototypeRepeatWire(items, value.`as`, value.key))
  }
}

@Serializable
data class PrototypeItem(
  val label: String,
  val icon: String? = null,
  /** An uploaded image asset id, or a `{light, dark}` pair of ids (#11218). */
  val image: PrototypeModeValue? = null,
) {
  constructor(
    label: String,
    icon: String? = null,
    image: String,
  ) : this(label, icon, PrototypeModeValue.Single(image))
}

@Serializable sealed class PrototypeAction

@SerialName("emit")
@Serializable
data class PrototypeEmitAction(
  val name: String,
  val payload: JsonElement? = null,
  val context: Map<String, EmitContextBinding>? = null,
  val requireValid: List<String>? = null,
) : PrototypeAction()

@SerialName("setPage")
@Serializable
data class PrototypeSetPageAction(
  val pager: String,
  val page: PrototypePageTarget,
) : PrototypeAction()

@SerialName("push")
@Serializable
data class PrototypePushAction(
  val stack: String,
  val screen: String,
  val transition: PrototypeStackTransition? = null,
) : PrototypeAction()

@SerialName("pop")
@Serializable
data class PrototypePopAction(val stack: String) : PrototypeAction()

@SerialName("popToRoot")
@Serializable
data class PrototypePopToRootAction(val stack: String) : PrototypeAction()

@SerialName("replace")
@Serializable
data class PrototypeReplaceAction(
  val stack: String,
  val screen: String,
  val transition: PrototypeStackTransition? = null,
) : PrototypeAction()

@SerialName("setState")
@Serializable
data class PrototypeSetStateAction(
  val key: String,
  val value: PrototypeScalar,
) : PrototypeAction()

@SerialName("toggle")
@Serializable
data class PrototypeToggleAction(val key: String) : PrototypeAction()

@SerialName("increment")
@Serializable
data class PrototypeIncrementAction(val key: String, val by: Double? = null) : PrototypeAction()

@SerialName("decrement")
@Serializable
data class PrototypeDecrementAction(val key: String, val by: Double? = null) : PrototypeAction()

@SerialName("dismiss") @Serializable data object PrototypeDismissAction : PrototypeAction()

/**
 * `setData`, `appendData` and `removeData` change the prototype's own `/data` on the device
 * (`prototype_data_actions_v1`, #12519). [path] is `/data/<RFC 6901 pointer>`; inside a `repeat`, a
 * whole `{index}` segment binds to the current row. [value] is an emit-context binding without
 * `page`: `{value}`, `{state}`, `{data}` and, in a repeat, `{item}` or `{index}`.
 */
@SerialName("setData")
@Serializable
data class PrototypeSetDataAction(val path: String, val value: EmitContextBinding) :
  PrototypeAction()

@SerialName("appendData")
@Serializable
data class PrototypeAppendDataAction(val path: String, val value: EmitContextBinding) :
  PrototypeAction()

@SerialName("removeData")
@Serializable
data class PrototypeRemoveDataAction(val path: String) : PrototypeAction()

/**
 * Moves the scroll whose id is [scroll] (`prototype_chat_scroll_v1`, #14232): [to] is `"start"`,
 * `"end"` or `{key: value}`, a `repeat.key` value of a row inside it, kept as JSON.
 */
@SerialName("scrollTo")
@Serializable
data class PrototypeScrollToAction(
  val scroll: String,
  val to: JsonElement,
  val animated: Boolean? = null,
) : PrototypeAction()

/**
 * An HTTP call from a tap (`prototype_network_v1`, #12523): the response goes to [into] (and its
 * `<into>__meta` sibling), [statusKey] follows `loading`, `success` and `error`, and [onSuccess] or
 * [onError] runs afterwards. [headers] and [query] entries are a literal string or a value binding
 * (`{state}`, `{data}`, `{value}`, and `{item}` / `{index}` in a repeat), kept as JSON because both
 * forms share a slot; [body] is a binding. [method] defaults to GET and [via] to `host`.
 */
@SerialName("request")
@Serializable
data class PrototypeRequestAction(
  val url: String,
  val method: String? = null,
  val headers: Map<String, JsonElement>? = null,
  val query: Map<String, JsonElement>? = null,
  val body: EmitContextBinding? = null,
  val into: String? = null,
  val statusKey: String? = null,
  val via: String? = null,
  val timeoutMs: Int? = null,
  val onSuccess: List<PrototypeAction>? = null,
  val onError: List<PrototypeAction>? = null,
) : PrototypeAction()

/**
 * A platform call (`prototype_platform_v1`, #14294): [call] is `<module>.<op>` from the contract's
 * `platformModules` table, each [args] entry a value binding (`{value}`, `{state}`, `{data}`,
 * `{platform}`, `{item}` / `{index}` in a repeat and `{event}` inside a handler) kept as JSON. The
 * result goes to [into] (and `<into>__meta`), [statusKey] follows `loading`, `success` and `error`,
 * and [onSuccess] or [onError] runs afterwards. Dispatch is the module registry's (#14295).
 */
@SerialName("platform")
@Serializable
data class PrototypePlatformAction(
  val call: String,
  val args: Map<String, JsonElement>? = null,
  val into: String? = null,
  val statusKey: String? = null,
  val timeoutMs: Int? = null,
  val onSuccess: List<PrototypeAction>? = null,
  val onError: List<PrototypeAction>? = null,
) : PrototypeAction()

@Serializable
sealed class PrototypeNode {
  abstract val id: String?
  abstract val testTag: String?
  /** The node's accessible label; replaces the label derived from its text, icon or kind. */
  abstract val contentDescription: String?
  abstract val onTap: List<PrototypeAction>?
  open val onLongPress: List<PrototypeAction>?
    get() = null

  open val onDoubleTap: List<PrototypeAction>?
    get() = null

  abstract val style: PrototypeStyle?
  abstract val styleWhen: List<PrototypeStyleWhen>?
  abstract val visibleWhen: PrototypeCondition?
  /**
   * `none`, `fade`, `expand`, `slide`, or (#14208) `slideStart`, `slideEnd` or `scale`, or (#15247)
   * `blurReplace`: the `visibleWhen` enter/exit; absent is fade + expand. Start and end follow the
   * layout direction. Written as the type alone or `{type, delayMs?}`.
   */
  abstract val transition: PrototypeTransition?
  /** Animates styleWhen-driven alpha, offset, scale, rotation, background and color (#14208). */
  abstract val animate: PrototypeAnimate?
  abstract val anchor: PrototypeAnchor?
  abstract val span: Int?
  abstract val safeAreaPadding: PrototypeSafeAreaPadding?
}

@SerialName("box")
@Serializable
data class PrototypeBoxNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val onLongPress: List<PrototypeAction>? = null,
  override val onDoubleTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val children: List<PrototypeNode>,
  val repeat: PrototypeRepeat? = null,
  /** Spaces the enters of `visibleWhen` children apart (#15247). */
  val stagger: PrototypeStagger? = null,
) : PrototypeNode()

@SerialName("row")
@Serializable
data class PrototypeRowNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val onLongPress: List<PrototypeAction>? = null,
  override val onDoubleTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val children: List<PrototypeNode>,
  val repeat: PrototypeRepeat? = null,
  /** Spaces the enters of `visibleWhen` children apart (#15247). */
  val stagger: PrototypeStagger? = null,
  val swipeActions: PrototypeSwipeActions? = null,
) : PrototypeNode()

@SerialName("column")
@Serializable
data class PrototypeColumnNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val onLongPress: List<PrototypeAction>? = null,
  override val onDoubleTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val children: List<PrototypeNode>,
  val repeat: PrototypeRepeat? = null,
  /** Spaces the enters of `visibleWhen` children apart (#15247). */
  val stagger: PrototypeStagger? = null,
) : PrototypeNode()

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

@SerialName("flow")
@Serializable
data class PrototypeFlowNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val children: List<PrototypeNode>,
  val repeat: PrototypeRepeat? = null,
  val maxLines: Int? = null,
) : PrototypeNode()

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

@SerialName("grid")
@Serializable
data class PrototypeGridNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val columns: PrototypeGridColumns,
  val children: List<PrototypeNode>,
  val repeat: PrototypeRepeat? = null,
) : PrototypeNode()

@SerialName("text")
@Serializable
data class PrototypeTextNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val onLongPress: List<PrototypeAction>? = null,
  override val onDoubleTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val text: String? = null,
  val spans: List<PrototypeTextSpan>? = null,
  /** Mentions, hashtags and URLs in [text] as links (`prototype_linkify_v1`, #14233). */
  val linkify: PrototypeLinkifyOptions? = null,
) : PrototypeNode()

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

@SerialName("image")
@Serializable
data class PrototypeImageNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val onLongPress: List<PrototypeAction>? = null,
  override val onDoubleTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  /** An uploaded image asset id, or a `{light, dark}` pair of ids (#11218). */
  val asset: PrototypeModeValue,
  val filter: PrototypeImageFilter? = null,
  val contentScale: String = "fit",
  /** Pinch, double-tap and pan zoom up to `maxScale` (#14208). */
  val zoomable: PrototypeZoomable? = null,
) : PrototypeNode()

@SerialName("icon")
@Serializable
data class PrototypeIconNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val onLongPress: List<PrototypeAction>? = null,
  override val onDoubleTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val name: String,
  /** One of filled (default), outlined, rounded, sharp, twoTone; closed by the contract. */
  val variant: String? = null,
) : PrototypeNode()

@SerialName("spacer")
@Serializable
data class PrototypeSpacerNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
) : PrototypeNode()

@SerialName("textField")
@Serializable
data class PrototypeTextFieldNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val stateKey: String,
  val placeholder: String? = null,
  val label: String? = null,
  val variant: String? = null,
  val supportingText: String? = null,
  val keyboardType: String? = null,
  val secure: Boolean? = null,
  val multiline: Boolean? = null,
  val minLines: Int? = null,
  val maxLines: Int? = null,
  val maxLength: Int? = null,
  val leadingIcon: String? = null,
  val trailingIcon: PrototypeAppBarAction? = null,
  val imeAction: String? = null,
  val onSubmit: List<PrototypeAction>? = null,
  val enabledWhen: PrototypeCondition? = null,
  val checks: List<PrototypeCheck>? = null,
  val validateOn: PrototypeValidateOn? = null,
) : PrototypeNode()

@SerialName("searchBar")
@Serializable
data class PrototypeSearchBarNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val stateKey: String,
  val placeholder: String? = null,
  val leadingIcon: String? = null,
  val trailingActions: List<PrototypeAppBarAction>? = null,
  val activeKey: String? = null,
  val variant: String? = null,
  val onSubmit: List<PrototypeAction>? = null,
  val child: PrototypeNode? = null,
) : PrototypeNode()

@SerialName("switch")
@Serializable
data class PrototypeSwitchNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val stateKey: String,
  val label: String? = null,
  val enabledWhen: PrototypeCondition? = null,
  val checks: List<PrototypeCheck>? = null,
  val validateOn: PrototypeValidateOn? = null,
) : PrototypeNode()

@SerialName("checkbox")
@Serializable
data class PrototypeCheckboxNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val stateKey: String,
  val label: String? = null,
  val enabledWhen: PrototypeCondition? = null,
  val checks: List<PrototypeCheck>? = null,
  val validateOn: PrototypeValidateOn? = null,
) : PrototypeNode()

@SerialName("button")
@Serializable
data class PrototypeButtonNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val label: String,
  val variant: String = "filled",
  val icon: String? = null,
  val enabledWhen: PrototypeCondition? = null,
) : PrototypeNode()

@SerialName("radioGroup")
@Serializable
data class PrototypeRadioGroupNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val stateKey: String,
  val options: List<PrototypeRadioOption>,
  val enabledWhen: PrototypeCondition? = null,
  val checks: List<PrototypeCheck>? = null,
  val validateOn: PrototypeValidateOn? = null,
) : PrototypeNode()

@SerialName("select")
@Serializable
data class PrototypeSelectNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val stateKey: String,
  val options: List<PrototypeRadioOption>,
  val label: String? = null,
) : PrototypeNode()

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

@SerialName("menu")
@Serializable
data class PrototypeMenuNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  val openWhen: PrototypeSheetCondition,
  val items: List<PrototypeMenuItem>,
) : PrototypeNode()

@SerialName("listItem")
@Serializable
data class PrototypeListItemNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val headline: String,
  val supporting: String? = null,
  val leadingIcon: String? = null,
  val trailing: PrototypeListItemTrailing? = null,
  val swipeActions: PrototypeSwipeActions? = null,
  val enabledWhen: PrototypeCondition? = null,
) : PrototypeNode()

@SerialName("slider")
@Serializable
data class PrototypeSliderNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val stateKey: String,
  val label: String? = null,
  val min: Double,
  val max: Double,
  val step: Double? = null,
  val enabledWhen: PrototypeCondition? = null,
  val checks: List<PrototypeCheck>? = null,
  val validateOn: PrototypeValidateOn? = null,
) : PrototypeNode()

@SerialName("chip")
@Serializable
data class PrototypeChipNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val label: String,
  val variant: String? = null,
  val stateKey: String? = null,
  val enabledWhen: PrototypeCondition? = null,
) : PrototypeNode()

@SerialName("card")
@Serializable
data class PrototypeCardNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val onLongPress: List<PrototypeAction>? = null,
  override val onDoubleTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val variant: String = "filled",
  val children: List<PrototypeNode>,
) : PrototypeNode()

/** An icon-only Material button; `variant` is standard (default), filled, tonal or outlined. */
@SerialName("iconButton")
@Serializable
data class PrototypeIconButtonNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val icon: String,
  val variant: String = "standard",
  val enabledWhen: PrototypeCondition? = null,
) : PrototypeNode()

/** A floating action button; a `label` makes it an extended FAB, which has no `size`. */
@SerialName("fab")
@Serializable
data class PrototypeFabNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val icon: String,
  val label: String? = null,
  val size: String = "regular",
  val enabledWhen: PrototypeCondition? = null,
) : PrototypeNode()

/** A single-select Material segmented button bound to a string state key, like a `radioGroup`. */
@SerialName("segmentedButton")
@Serializable
data class PrototypeSegmentedButtonNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val stateKey: String,
  val options: List<PrototypeRadioOption>,
) : PrototypeNode()

/** A Material top app bar with a title, an optional navigation icon and up to three actions. */
@SerialName("topAppBar")
@Serializable
data class PrototypeTopAppBarNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val title: String,
  val variant: String = "small",
  val navigationIcon: PrototypeAppBarAction? = null,
  val actions: List<PrototypeAppBarAction>? = null,
) : PrototypeNode()

/** A Material divider line, horizontal (default) or vertical. */
@SerialName("divider")
@Serializable
data class PrototypeDividerNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val orientation: String = "horizontal",
) : PrototypeNode()

/** A Material badge: a small dot, or a short `text` such as a count. */
@SerialName("badge")
@Serializable
data class PrototypeBadgeNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val text: String? = null,
) : PrototypeNode()

/**
 * A Material progress indicator, linear (default) or circular: determinate over 0..[max] when bound
 * to a number, indeterminate otherwise.
 */
@SerialName("progress")
@Serializable
data class PrototypeProgressNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val variant: String = "linear",
  val stateKey: String? = null,
  val max: Double? = null,
) : PrototypeNode()

/**
 * A `chart` (#14209): a [variant] line, area, bar or ring over 1–4 [series], each the objects of a
 * `/data` array read through its `y` (and optional `x`) member. A ring draws its one series' latest
 * value against [goal]; other variants draw [goal] as a reference line.
 */
@SerialName("chart")
@Serializable
data class PrototypeChartNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val variant: String,
  val series: List<PrototypeChartSeries>,
  val yRange: PrototypeChartRange? = null,
  val xLabels: String = "none",
  val goal: Double? = null,
) : PrototypeNode()

/** One chart series: the `/data` array at [path], its points' [y] and optional [x] members. */
@Serializable
data class PrototypeChartSeries(
  val path: String,
  val x: String? = null,
  val y: String,
  val label: String,
  val color: PrototypeModeValue? = null,
)

/**
 * A Material alert dialog, open while [openWhen] holds. Its buttons and scrim close it by writing
 * the opposite boolean; [child] is optional custom content between the text and the buttons.
 */
@SerialName("dialog")
@Serializable
data class PrototypeDialogNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val openWhen: PrototypeSheetCondition,
  val title: String? = null,
  val text: String? = null,
  val icon: String? = null,
  val confirm: PrototypeDialogButton,
  val dismiss: PrototypeDialogButton? = null,
  val child: PrototypeNode? = null,
) : PrototypeNode()

/**
 * A Material snackbar at the bottom of the window, shown while [openWhen] holds. Without
 * [durationMs] it stays until its action closes it or the state changes; with it, it closes itself
 * by writing the opposite boolean once it has been open that long (a wall-clock timer).
 */
@SerialName("snackbar")
@Serializable
data class PrototypeSnackbarNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val openWhen: PrototypeSheetCondition,
  val text: String,
  val action: PrototypeDialogButton? = null,
  val durationMs: Int? = null,
) : PrototypeNode()

/** A Material time picker bound to integer hour (0..23) and minute (0..59) state keys. */
@SerialName("timePicker")
@Serializable
data class PrototypeTimePickerNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val hourKey: String,
  val minuteKey: String,
  val is24Hour: Boolean? = null,
  val enabledWhen: PrototypeCondition? = null,
  val checks: List<PrototypeCheck>? = null,
  val validateOn: PrototypeValidateOn? = null,
) : PrototypeNode()

/** A Material date picker bound to a `YYYY-MM-DD` string state key. */
@SerialName("datePicker")
@Serializable
data class PrototypeDatePickerNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val stateKey: String,
  val enabledWhen: PrototypeCondition? = null,
  val checks: List<PrototypeCheck>? = null,
  val validateOn: PrototypeValidateOn? = null,
) : PrototypeNode()

@SerialName("scroll")
@Serializable
data class PrototypeScrollNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val axis: String = "vertical",
  val refresh: PrototypeScrollRefresh? = null,
  val fadeEdges: PrototypeFadeEdges? = null,
  /** Chat lists (`prototype_chat_scroll_v1`, #14232): anchored at the end of its content. */
  val reverse: Boolean? = null,
  /** Follows rows appended while the scroll is at its end. */
  val stickToEnd: Boolean? = null,
  /** A boolean state key the runtime keeps true while the scroll is at its end. */
  val atEndKey: String? = null,
  /** Run once each time the scroll reaches its start, to load older history. */
  val onStartReached: List<PrototypeAction>? = null,
  val child: PrototypeNode,
) : PrototypeNode()

@SerialName("pager")
@Serializable
data class PrototypePagerNode(
  override val id: String,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val children: List<PrototypeNode>,
  val axis: String? = null,
  val pageSpacing: Double? = null,
  val peek: PrototypePagerPeek? = null,
  val pageSize: PrototypePagerPageSize? = null,
  val indicator: String? = null,
) : PrototypeNode()

/**
 * A horizontally scrolling, snapping row of [children] (one item each, expanded from [repeat]).
 * [variant] is `multiBrowse` (default), `hero` or `uncontained`; [itemWidth] is the preferred or
 * fixed item width in dp.
 */
@SerialName("carousel")
@Serializable
data class PrototypeCarouselNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val children: List<PrototypeNode>,
  val repeat: PrototypeRepeat? = null,
  val variant: String? = null,
  val itemWidth: Double,
  val itemSpacing: Double? = null,
) : PrototypeNode()

@Serializable data class PrototypePagerPeek(val start: Double? = null, val end: Double? = null)

@SerialName("stack")
@Serializable
data class PrototypeStackNode(
  override val id: String,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val start: String,
  val screens: Map<String, PrototypeNode>,
) : PrototypeNode() {
  /** Typed navigation transition; [transition] remains the shared wire slot. */
  val stackTransition: PrototypeStackTransition?
    get() = transition?.type?.let(PrototypeStackTransition::fromValue)
}

@SerialName("tabBar")
@Serializable
data class PrototypeTabBarNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val items: List<PrototypeItem>,
  val pager: String? = null,
  val stateKey: String? = null,
  val scrollable: Boolean = false,
) : PrototypeNode()

@SerialName("bottomNav")
@Serializable
data class PrototypeBottomNavNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val items: List<PrototypeItem>,
  val pager: String? = null,
  val stateKey: String? = null,
) : PrototypeNode()

@SerialName("bottomSheet")
@Serializable
data class PrototypeBottomSheetNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val child: PrototypeNode,
  val openWhen: PrototypeSheetCondition,
  val detents: List<PrototypeDetent>,
  val scrim: PrototypeModeValue? = null,
  val dragHandle: Boolean = true,
  val dismissOnSwipe: Boolean = true,
) : PrototypeNode()

@SerialName("tooltip")
@Serializable
data class PrototypeTooltipNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val text: String,
  val openWhen: PrototypeSheetCondition,
  val anchorTo: String? = null,
  val caret: String = "auto",
  val spotlight: PrototypeTooltipSpotlight? = null,
  val onDismiss: List<PrototypeAction>? = null,
) : PrototypeNode()

@SerialName("drawer")
@Serializable
data class PrototypeDrawerNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val transition: PrototypeTransition? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val span: Int? = null,
  val edge: String,
  val openWhen: PrototypeSheetCondition,
  val child: PrototypeNode,
  val scrim: PrototypeModeValue? = null,
  val dismissOnSwipe: Boolean = true,
) : PrototypeNode()

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
)

@Serializable
data class PrototypeSpec(
  val id: String,
  val window: PrototypeWindow,
  val state: Map<String, PrototypeScalar>? = null,
  val root: PrototypeNode,
  val theme: PrototypeSpecTheme? = null,
  /** `none` opts out of prototype animation; absent or `standard` follows the system scale. */
  val motion: String? = null,
  val data: JsonObject? = null,
  /** The state keys and `/data` pointers the device keeps across shows (#12522). */
  val storage: PrototypeStorageBlock? = null,
  /** What the spec needs from the platform before show (#14294). */
  val requires: PrototypeRequires? = null,
  /** `platform.on`: action lists run when a platform event is delivered (#14294). */
  val platform: PrototypePlatformHandlers? = null,
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

@Serializable
@SerialName("startTimer")
data class PrototypeStartTimerAction(
  val id: String,
  val afterMs: Int,
  val everyMs: Int? = null,
  val maxRuns: Int? = null,
  val actions: List<PrototypeAction>,
) : PrototypeAction()

@Serializable
@SerialName("cancelTimer")
data class PrototypeCancelTimerAction(val id: String) : PrototypeAction()
