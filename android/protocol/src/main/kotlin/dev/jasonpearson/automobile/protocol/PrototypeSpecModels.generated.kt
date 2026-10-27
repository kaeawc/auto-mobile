// Generated from schemas/prototype-spec-contract.json; do not edit.
// Regenerate: bun scripts/prototype/generate-prototype-spec-models.ts
package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

@Serializable
data class PrototypeRequestUploadFile(
  val asset: String,
)

@Serializable
data class PrototypeRequestUploadPart(
  val name: String,
  val value: kotlinx.serialization.json.JsonObject? = null,
  val file: PrototypeRequestUploadFile? = null,
  val filename: String? = null,
  val contentType: String? = null,
)

@Serializable
data class PrototypeChannel(
  val kind: String,
  val url: String,
  val protocols: List<String>? = null,
  val headers: Map<String, JsonElement>? = null,
  val via: String? = null,
  val connect: String? = null,
  val statusKey: String? = null,
  val reconnect: PrototypeChannelReconnect? = null,
  val decode: String? = null,
  val routes: List<PrototypeChannelRoute>? = null,
  val onOpen: List<PrototypeAction>? = null,
  val onClose: List<PrototypeAction>? = null,
  val onError: List<PrototypeAction>? = null,
)

@Serializable
data class PrototypeChannelReconnect(
  val maxAttempts: Int,
  val initialDelayMs: Int,
  val maxDelayMs: Int,
)

@Serializable
data class PrototypeChannelRoute(
  val `when`: JsonElement? = null,
  val actions: List<PrototypeAction>,
)

@Serializable
data class PrototypeIconEffectTrigger(
  val key: String? = null,
  val data: String? = null,
)

@Serializable
data class PrototypeIconEffect(
  val type: String,
  val trigger: PrototypeIconEffectTrigger? = null,
  val repeat: PrototypeIconEffectRepeat? = null,
)

@Serializable
data class PrototypePress(
  val scale: Double? = null,
  val alpha: Double? = null,
)

@Serializable
data class PrototypeShared(
  val key: String,
  val `as`: String,
)

@Serializable
data class PrototypeShadowOffset(
  val x: Double,
  val y: Double,
)

@Serializable
data class PrototypeShadow(
  val color: PrototypeModeValue,
  val radius: Double,
  val spread: Double? = null,
  val offset: PrototypeShadowOffset? = null,
  val inner: Boolean? = null,
)

@Serializable
data class PrototypeFadeEdges(
  val top: Double? = null,
  val bottom: Double? = null,
  val start: Double? = null,
  val end: Double? = null,
)

@Serializable
data class PrototypeBackdrop(
  val material: String,
  val blur: Int? = null,
  val tint: String? = null,
)

@Serializable
data class PrototypeSemantics(
  val heading: Boolean? = null,
  val group: Boolean? = null,
  val liveRegion: String? = null,
  val label: String? = null,
  val hint: String? = null,
  val traits: List<String>? = null,
)

@Serializable
data class PrototypeImageFilter(
  val saturation: Double? = null,
  val tint: PrototypeModeValue? = null,
)

/** Tooltip spotlight hole: padding 0..64 dp (default 8), cornerRadius 0..64 dp (default 12). */
@Serializable
data class PrototypeTooltipSpotlight(
  val padding: Int? = null,
  val cornerRadius: Int? = null,
)

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
data class PrototypeIncrementAction(
  val key: String,
  val by: Double? = null,
) : PrototypeAction()

@SerialName("dismiss") @Serializable data object PrototypeDismissAction : PrototypeAction()

@SerialName("decrement")
@Serializable
data class PrototypeDecrementAction(
  val key: String,
  val by: Double? = null,
) : PrototypeAction()

@SerialName("push")
@Serializable
data class PrototypePushAction(
  val stack: String,
  val screen: String,
  val transition: String? = null,
  val source: String? = null,
  val params: Map<String, JsonElement>? = null,
) : PrototypeAction()

@SerialName("pop")
@Serializable
data class PrototypePopAction(
  val stack: String,
  val force: Boolean? = null,
) : PrototypeAction()

@SerialName("popToRoot")
@Serializable
data class PrototypePopToRootAction(val stack: String) : PrototypeAction()

@SerialName("replace")
@Serializable
data class PrototypeReplaceAction(
  val stack: String,
  val screen: String,
  val transition: String? = null,
  val source: String? = null,
  val params: Map<String, JsonElement>? = null,
) : PrototypeAction()

/**
 * `setData`, `appendData` and `removeData` change the prototype's own `/data` on the device
 * (`prototype_data_actions_v1`, #12519). [path] is `/data/<RFC 6901 pointer>`; inside a `repeat`, a
 * whole `{index}` segment binds to the current row. [value] is an emit-context binding without
 * `page`: `{value}`, `{state}`, `{data}` and, in a repeat, `{item}` or `{index}`.
 */
@SerialName("setData")
@Serializable
data class PrototypeSetDataAction(
  val path: String,
  val value: EmitContextBinding,
) : PrototypeAction()

@SerialName("appendData")
@Serializable
data class PrototypeAppendDataAction(
  val path: String,
  val value: EmitContextBinding,
  val maxItems: Int? = null,
) : PrototypeAction()

@SerialName("removeData")
@Serializable
data class PrototypeRemoveDataAction(val path: String) : PrototypeAction()

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
  val method: String? = null,
  val url: String,
  val headers: Map<String, JsonElement>? = null,
  val query: Map<String, JsonElement>? = null,
  val body: EmitContextBinding? = null,
  val into: String? = null,
  val statusKey: String? = null,
  val via: String? = null,
  val timeoutMs: Int? = null,
  val onSuccess: List<PrototypeAction>? = null,
  val onError: List<PrototypeAction>? = null,
  val append: PrototypeRequestAppend? = null,
  val progressKey: String? = null,
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

@SerialName("startTimer")
@Serializable
data class PrototypeStartTimerAction(
  val id: String,
  val afterMs: Int,
  val everyMs: Int? = null,
  val maxRuns: Int? = null,
  val actions: List<PrototypeAction>,
) : PrototypeAction()

@SerialName("cancelTimer")
@Serializable
data class PrototypeCancelTimerAction(val id: String) : PrototypeAction()

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

@SerialName("prependData")
@Serializable
data class PrototypePrependDataAction(
  val path: String,
  val value: EmitContextBinding,
) : PrototypeAction()

@SerialName("upsertData")
@Serializable
data class PrototypeUpsertDataAction(
  val path: String,
  val value: EmitContextBinding,
  val maxItems: Int? = null,
  val key: String,
) : PrototypeAction()

@SerialName("setStack")
@Serializable
data class PrototypeSetStackAction(
  val stack: String,
  val path: List<PrototypeRouteEntry>,
) : PrototypeAction()

@Serializable
sealed class PrototypeNode {
  abstract val id: String?
  abstract val testTag: String?
  /** The node's accessible label; replaces the label derived from its text, icon or kind. */
  abstract val contentDescription: String?
  open val onTap: List<PrototypeAction>?
    get() = null

  open val onLongPress: List<PrototypeAction>?
    get() = null

  open val onDoubleTap: List<PrototypeAction>?
    get() = null

  abstract val style: PrototypeStyle?
  abstract val styleWhen: List<PrototypeStyleWhen>?
  abstract val visibleWhen: PrototypeCondition?
  abstract val shared: PrototypeShared?
  abstract val sharedKey: String?
  /**
   * `none`, `fade`, `expand`, `slide`, or (#14208) `slideStart`, `slideEnd` or `scale`, or (#15247)
   * `blurReplace`: the `visibleWhen` enter/exit; absent is fade + expand. Start and end follow the
   * layout direction. Written as the type alone or `{type, delayMs?}`.
   */
  abstract val transition: PrototypeTransition?
  /** Draw-only press feedback, independent of the minimum touch target. */
  abstract val press: PrototypePress?
  /** Animates styleWhen-driven draw and layout styles. */
  abstract val animate: PrototypeAnimate?
  abstract val anchor: PrototypeAnchor?
  abstract val span: Int?
  abstract val safeAreaPadding: PrototypeSafeAreaPadding?
  abstract val scrollTransition: PrototypeScrollTransition?
  abstract val scrollLinked: PrototypeScrollLinked?
  abstract val onAppear: List<PrototypeAction>?
  abstract val semantics: PrototypeSemantics?
  abstract val android: PrototypeAndroidNamespace?
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val swipeActions: PrototypeSwipeActions? = null,
  val children: List<PrototypeNode>,
  val repeat: PrototypeRepeat? = null,
  /** Spaces the enters of `visibleWhen` children apart (#15247). */
  val stagger: PrototypeStagger? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val children: List<PrototypeNode>,
  val repeat: PrototypeRepeat? = null,
  /** Spaces the enters of `visibleWhen` children apart (#15247). */
  val stagger: PrototypeStagger? = null,
) : PrototypeNode()

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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val children: List<PrototypeNode>,
  val repeat: PrototypeRepeat? = null,
  val maxLines: Int? = null,
) : PrototypeNode()

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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val children: List<PrototypeNode>,
  val repeat: PrototypeRepeat? = null,
  val columns: PrototypeGridColumns,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val children: List<PrototypeNode>,
  val repeat: PrototypeRepeat? = null,
  val variant: String? = null,
  val itemWidth: Double,
  val itemSpacing: Double? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val text: String? = null,
  val spans: List<PrototypeTextSpan>? = null,
  /** Mentions, hashtags and URLs in [text] as links (`prototype_linkify_v1`, #14233). */
  val linkify: PrototypeLinkifyOptions? = null,
  val contentTransition: String? = null,
) : PrototypeNode()

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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  /** An uploaded image asset id, or a `{light, dark}` pair of ids (#11218). */
  val asset: PrototypeModeValue,
  val contentScale: String = "fit",
  /** Pinch, double-tap and pan zoom up to `maxScale` (#14208). */
  val zoomable: PrototypeZoomable? = null,
  val filter: PrototypeImageFilter? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val effect: PrototypeIconEffect? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
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
  val checks: List<PrototypeCheck>? = null,
  val validateOn: PrototypeValidateOn? = null,
  val enabledWhen: PrototypeCondition? = null,
  val errorWhen: PrototypeCondition? = null,
  val errorText: String? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val stateKey: String,
  val label: String? = null,
  val checks: List<PrototypeCheck>? = null,
  val validateOn: PrototypeValidateOn? = null,
  val enabledWhen: PrototypeCondition? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val stateKey: String,
  val label: String? = null,
  val checks: List<PrototypeCheck>? = null,
  val validateOn: PrototypeValidateOn? = null,
  val enabledWhen: PrototypeCondition? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val stateKey: String,
  val options: List<PrototypeRadioOption>,
  val checks: List<PrototypeCheck>? = null,
  val validateOn: PrototypeValidateOn? = null,
  val enabledWhen: PrototypeCondition? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val stateKey: String,
  val options: List<PrototypeRadioOption>,
  val label: String? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val stateKey: String,
  val label: String? = null,
  val min: Double,
  val max: Double,
  val step: Double? = null,
  val checks: List<PrototypeCheck>? = null,
  val validateOn: PrototypeValidateOn? = null,
  val enabledWhen: PrototypeCondition? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val title: String,
  val variant: String = "small",
  val navigationIcon: PrototypeAppBarAction? = null,
  val actions: List<PrototypeAppBarAction>? = null,
  val onScroll: String? = null,
  val scroll: String? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val variant: String = "linear",
  val stateKey: String? = null,
  val max: Double? = null,
) : PrototypeNode()

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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val openWhen: PrototypeSheetCondition,
  val title: String? = null,
  val text: String? = null,
  val icon: String? = null,
  val confirm: PrototypeDialogButton,
  val dismiss: PrototypeDialogButton? = null,
  val child: PrototypeNode? = null,
) : PrototypeNode()

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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val openWhen: PrototypeSheetCondition,
  val items: List<PrototypeMenuItem>,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val hourKey: String,
  val minuteKey: String,
  val is24Hour: Boolean? = null,
  val checks: List<PrototypeCheck>? = null,
  val validateOn: PrototypeValidateOn? = null,
  val enabledWhen: PrototypeCondition? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val stateKey: String,
  val checks: List<PrototypeCheck>? = null,
  val validateOn: PrototypeValidateOn? = null,
  val enabledWhen: PrototypeCondition? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val axis: String = "vertical",
  val refresh: PrototypeScrollRefresh? = null,
  /** Chat lists (`prototype_chat_scroll_v1`, #14232): anchored at the end of its content. */
  val reverse: Boolean? = null,
  /** Follows rows appended while the scroll is at its end. */
  val stickToEnd: Boolean? = null,
  /** A boolean state key the runtime keeps true while the scroll is at its end. */
  val atEndKey: String? = null,
  /** Run once each time the scroll reaches its start, to load older history. */
  val onStartReached: List<PrototypeAction>? = null,
  val child: PrototypeNode,
  val fadeEdges: PrototypeFadeEdges? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val children: List<PrototypeNode>,
  val axis: String? = null,
  val pageSpacing: Double? = null,
  val peek: PrototypePagerPeek? = null,
  val pageSize: PrototypePagerPageSize? = null,
  val indicator: String? = null,
  val stateKey: String? = null,
) : PrototypeNode()

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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val items: List<PrototypeItem>,
  val pager: String? = null,
  val stateKey: String? = null,
  val scrollable: Boolean = false,
  val onScroll: String? = null,
  val scroll: String? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val items: List<PrototypeItem>,
  val pager: String? = null,
  val stateKey: String? = null,
  val onScroll: String? = null,
  val scroll: String? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val child: PrototypeNode,
  val openWhen: PrototypeSheetCondition,
  val detents: List<PrototypeDetent>,
  val scrim: PrototypeModeValue? = null,
  val dragHandle: Boolean = true,
  val dismissOnSwipe: Boolean = true,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val stateKey: String,
  val placeholder: String? = null,
  val leadingIcon: String? = null,
  val trailingActions: List<PrototypeAppBarAction>? = null,
  val activeKey: String? = null,
  val variant: String? = null,
  val onSubmit: List<PrototypeAction>? = null,
  val child: PrototypeNode? = null,
) : PrototypeNode()

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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val start: String,
  val screens: Map<String, PrototypeNode>,
  val routes: Map<String, PrototypeRoute>? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val variant: String,
  val series: List<PrototypeChartSeries>,
  val yRange: PrototypeChartRange? = null,
  val xLabels: String = "none",
  val goal: Double? = null,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val openWhen: PrototypeSheetCondition,
  val text: String,
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
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val child: PrototypeNode,
  val edge: String,
  val openWhen: PrototypeSheetCondition,
  val scrim: PrototypeModeValue? = null,
  val dismissOnSwipe: Boolean = true,
) : PrototypeNode()

@SerialName("list")
@Serializable
data class PrototypeListNode(
  override val id: String? = null,
  override val testTag: String? = null,
  override val contentDescription: String? = null,
  override val onTap: List<PrototypeAction>? = null,
  override val style: PrototypeStyle? = null,
  override val styleWhen: List<PrototypeStyleWhen>? = null,
  override val visibleWhen: PrototypeCondition? = null,
  override val shared: PrototypeShared? = null,
  override val sharedKey: String? = null,
  override val transition: PrototypeTransition? = null,
  override val press: PrototypePress? = null,
  override val animate: PrototypeAnimate? = null,
  override val anchor: PrototypeAnchor? = null,
  override val span: Int? = null,
  override val safeAreaPadding: PrototypeSafeAreaPadding? = null,
  override val scrollTransition: PrototypeScrollTransition? = null,
  override val scrollLinked: PrototypeScrollLinked? = null,
  override val onAppear: List<PrototypeAction>? = null,
  override val semantics: PrototypeSemantics? = null,
  override val android: PrototypeAndroidNamespace? = null,
  val axis: String = "vertical",
  val refresh: PrototypeScrollRefresh? = null,
  val repeat: PrototypeRepeat,
  val children: List<PrototypeNode>,
  val header: PrototypeNode? = null,
  val footer: PrototypeNode? = null,
  val spacing: Double? = null,
  val contentPadding: Double? = null,
  val onEndReached: List<PrototypeAction>? = null,
  val endThreshold: Int = 3,
  val maxItems: Int? = null,
) : PrototypeNode()

@Serializable
data class PrototypeRouteEntry(
  val screen: String,
  val params: Map<String, JsonElement>? = null,
)

@Serializable
data class PrototypeRoute(
  val params: Map<String, String>? = null,
  val onEnter: List<PrototypeAction>? = null,
  val onBack: List<PrototypeAction>? = null,
)

@Serializable
data class PrototypeScrollEdge(
  val scale: Double? = null,
  val alpha: Double? = null,
  val rotation: Double? = null,
)

@Serializable
data class PrototypeScrollTransition(
  val axis: String,
  val edge: PrototypeScrollEdge,
)

@Serializable
data class PrototypeScrollLinked(
  val source: String,
  val range: List<Double>,
  val alpha: List<Double>? = null,
  val scale: List<Double>? = null,
  val offsetY: List<Double>? = null,
  val offsetX: List<Double>? = null,
  val blur: List<Double>? = null,
)

@Serializable
data class PrototypeIosPresentationNamespaceTab(
  val role: String,
)

@Serializable
data class PrototypeIosPresentationNamespaceSheet(
  val sizing: String,
)

@Serializable
data class PrototypeIosPresentationNamespace(
  val buttonStyle: String? = null,
  val tab: PrototypeIosPresentationNamespaceTab? = null,
  val sheet: PrototypeIosPresentationNamespaceSheet? = null,
  val hover: String? = null,
  val navigationTitle: String? = null,
)

@Serializable
data class PrototypeIosNamespaceTab(
  val role: String,
)

@Serializable
data class PrototypeIosNamespaceSheet(
  val sizing: String,
)

@Serializable
data class PrototypeIosNamespace(
  val buttonStyle: String? = null,
  val bottomAccessory: PrototypeNode? = null,
  val tab: PrototypeIosNamespaceTab? = null,
  val sheet: PrototypeIosNamespaceSheet? = null,
  val hover: String? = null,
  val navigationTitle: String? = null,
)

@Serializable
data class PrototypeAndroidNamespacePredictiveBack(
  val style: String,
)

@Serializable
data class PrototypeAndroidNamespace(
  val predictiveBack: PrototypeAndroidNamespacePredictiveBack? = null,
  val indication: String? = null,
)

@Serializable
data class PrototypeOffset(
  val x: Double,
  val y: Double,
)

@Serializable
data class PrototypePadding(
  val top: Double? = null,
  val bottom: Double? = null,
  val start: Double? = null,
  val end: Double? = null,
)

@Serializable
data class PrototypeBounds(
  val x: Double,
  val y: Double,
  val width: Double,
  val height: Double,
)

@Serializable
data class PrototypeSheetCondition(
  val key: String,
  val equals: Boolean,
)

@Serializable
data class PrototypeSafeAreaPadding(
  val edges: List<String>,
  val types: List<String>,
)

/** A node's style animation (#14208): `durationMs` 0..2000 (default 300) and `easing`. */
@Serializable
data class PrototypeAnimate(
  val durationMs: Int? = null,
  val easing: String? = null,
)

/** Container `stagger` (#15247): each `visibleWhen` child enters `ms` after the previous one. */
@Serializable
data class PrototypeStagger(
  val ms: Int,
  val order: String? = null,
)

/** An image's zoom range: 1 up to `maxScale` (1..8). */
@Serializable
data class PrototypeZoomable(
  val maxScale: Double,
)

@Serializable
data class PrototypeRadioOption(
  val value: String,
  val label: String,
)

/** A fixed y axis for a chart; `max` is above `min`. */
@Serializable
data class PrototypeChartRange(
  val min: Double,
  val max: Double,
)

@Serializable
data class PrototypeContainer(
  val elementId: String? = null,
  val text: String? = null,
  val index: Int? = null,
  val selectionStrategy: String? = null,
  val container: PrototypeContainer? = null,
)

@Serializable
data class PrototypeSelector(
  val elementId: String? = null,
  val text: String? = null,
  val testTag: String? = null,
  val container: PrototypeContainer? = null,
)

@Serializable
data class PrototypeShader(
  val asset: String,
  val uniforms: Map<String, Double>? = null,
)

@Serializable
data class PrototypeStyleWhen(
  val `when`: PrototypeCondition,
  val style: PrototypeStyle,
)

/** An icon-only control in a `topAppBar`: the icon, its accessible label and its tap. */
@Serializable
data class PrototypeAppBarAction(
  val icon: String,
  val label: String,
  val onTap: List<PrototypeAction>? = null,
)

/** A `dialog` or `snackbar` button: a tap closes its container, then runs `onTap`. */
@Serializable
data class PrototypeDialogButton(
  val label: String,
  val onTap: List<PrototypeAction>? = null,
)

/**
 * Pull-to-refresh on a vertical [PrototypeScrollNode]: the indicator shows while the boolean state
 * [stateKey] is true. A pull writes true to it and runs [onRefresh]; the prototype or a patch
 * writes false to end it.
 */
@Serializable
data class PrototypeScrollRefresh(
  val stateKey: String,
  val onRefresh: List<PrototypeAction>,
)

@Serializable sealed class PrototypeAnchor

/**
 * Screen-space dp [bounds]. [alignment] (`cover` when absent) lays the node over them or along one
 * of their edges, then [offset] shifts it. The host resolves an element anchor into this shape, so
 * it is the only anchor the renderer lays out (#9316).
 */
@SerialName("bounds")
@Serializable
data class PrototypeBoundsAnchor(
  val bounds: PrototypeBounds,
  val alignment: String? = null,
  val offset: PrototypeOffset? = null,
) : PrototypeAnchor()

@SerialName("element")
@Serializable
data class PrototypeElementAnchor(
  val selector: PrototypeSelector,
  val alignment: String,
  val offset: PrototypeOffset? = null,
) : PrototypeAnchor()

@Serializable sealed class PrototypePlacement

@SerialName("fullscreen")
@Serializable
data class PrototypeFullscreenPlacement(
  val scrim: PrototypeModeValue? = null,
) : PrototypePlacement()

@SerialName("sheet")
@Serializable
data class PrototypeSheetPlacement(
  val edge: String,
  val height: Double,
) : PrototypePlacement()

@SerialName("floating")
@Serializable
data class PrototypeFloatingPlacement(
  val gravity: String,
  val offset: PrototypeOffset,
) : PrototypePlacement()

@Serializable sealed class PrototypeGradient

@SerialName("linear")
@Serializable
data class PrototypeLinearGradient(
  val angle: Double,
  val stops: List<PrototypeGradientStop>,
) : PrototypeGradient()

@SerialName("radial")
@Serializable
data class PrototypeRadialGradient(val stops: List<PrototypeGradientStop>) : PrototypeGradient()

/** The control at the end of a `listItem`: a bound switch or checkbox, or a decorative icon. */
@Serializable sealed class PrototypeListItemTrailing

@SerialName("switch")
@Serializable
data class PrototypeListItemSwitch(val stateKey: String) : PrototypeListItemTrailing()

@SerialName("checkbox")
@Serializable
data class PrototypeListItemCheckbox(val stateKey: String) : PrototypeListItemTrailing()

@SerialName("icon")
@Serializable
data class PrototypeListItemIcon(val name: String) : PrototypeListItemTrailing()

/** One gradient stop: a colour slot and an optional position in 0...1. */
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
data class PrototypeBorder(
  val width: Double,
  val color: PrototypeModeValue? = null,
  val gradient: PrototypeGradient? = null,
) {
  constructor(
    width: Double,
    color: String,
    gradient: PrototypeGradient? = null,
  ) : this(width, PrototypeModeValue.Single(color), gradient)
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

@Serializable
data class PrototypeCondition(
  val key: String? = null,
  val equals: PrototypeScalar? = null,
  val notEquals: PrototypeScalar? = null,
  val gt: Double? = null,
  val lt: Double? = null,
  /** With [data]: holds when that value is missing, `[]`, `{}` or `""` (#14207). */
  val empty: Boolean? = null,
  val all: List<PrototypeCondition>? = null,
  val any: List<PrototypeCondition>? = null,
  val not: PrototypeCondition? = null,
  val data: String? = null,
  val valid: PrototypeValidityKeys? = null,
  /** A `/platform` pointer (#14294); platform state is device-owned and read-only. */
  val platform: String? = null,
  val contains: PrototypeScalar? = null,
  val startsWith: PrototypeScalar? = null,
  val lengthGt: Int? = null,
  val lengthLt: Int? = null,
)

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
  val gradient: PrototypeGradient? = null,
  val aspectRatio: Double? = null,
  /** A dp draw offset; it moves the drawn and touchable node without changing its layout slot. */
  val offset: PrototypeOffset? = null,
  val alpha: Double? = null,
  /** Scale (0.5-1) a tappable node shrinks to while pressed; absent leaves it unscaled. */
  val pressScale: Double? = null,
  /** An animated highlight sweep over a loading placeholder's background (#14207). */
  val shimmer: Boolean? = null,
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
  /** A drawn scale (0-4) about the node's centre; absent is 1 (#14208). */
  val scale: Double? = null,
  /** A drawn rotation in degrees (-360..360) about the node's centre (#14208). */
  val rotation: Double? = null,
  val shader: PrototypeShader? = null,
  val shadows: List<PrototypeShadow>? = null,
  val cornerStyle: String? = null,
  val effects: List<JsonObject>? = null,
)
