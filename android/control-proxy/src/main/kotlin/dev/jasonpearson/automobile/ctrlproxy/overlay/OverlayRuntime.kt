package dev.jasonpearson.automobile.ctrlproxy.overlay

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*

fun interface OverlayEventSink {
  suspend fun send(event: OverlayEvent)
}

data class OverlayRuntimeSnapshot(
  val spec: OverlaySpec,
  val pages: Map<String, Int>,
  val active: Boolean = true,
  /**
   * Bumped per key each time the controller's text for that key is replaced from outside the field:
   * an authoritative patch that changes it, or a rejected edit that must be reverted. The field
   * adopts the value whenever the epoch moves; see [TextChange].
   */
  val textEpochs: Map<String, Int> = emptyMap(),
) {
  val state: Map<String, OverlayScalar>
    get() = spec.state.orEmpty()
}

sealed interface OverlayInteraction {
  data object HostDismiss : OverlayInteraction

  data class Tap(val actions: List<OverlayAction>) : OverlayInteraction

  data class PagerMotion(val pager: String, val page: Int, val scrolling: Boolean) :
    OverlayInteraction

  data class SettledPage(val pager: String, val page: Int) : OverlayInteraction

  /**
   * [epoch] is the key's [OverlayRuntimeSnapshot.textEpochs] entry the editing field last rendered.
   * An edit typed against text an authoritative `update_overlay` has since replaced is stale and is
   * dropped, so the external value wins over reports still in flight.
   */
  data class TextChange(val key: String, val value: String, val epoch: Int = 0) : OverlayInteraction

  data class Select(
    val pager: String?,
    val key: String?,
    val index: Int,
    val actions: List<OverlayAction> = emptyList(),
  ) : OverlayInteraction

  data class SheetDismiss(val condition: OverlaySheetCondition) : OverlayInteraction
}

/**
 * Device-free transitions, called serially by the controller. Only settled pager positions enter
 * this layer: intermediate fling frames never mutate pages or emit. Snapshots are immutable.
 * Sequence allocation precedes delivery, so a disconnected/dropping sink still consumes a number.
 * Dismissal finishes removal/delivery even if disposing Compose cancels the gesture coroutine.
 * Dismissal closes the runtime before delivery; its dismissed event is the final permitted event.
 */
class OverlayRuntime(
  spec: OverlaySpec,
  private val sink: OverlayEventSink = OverlayEventSink {},
  private val clock: () -> Long = System::currentTimeMillis,
  private val nextSequence: () -> Long,
  private val requestDismiss: suspend () -> Boolean = { true },
  previousPages: Map<String, Int> = emptyMap(),
) {
  private val mutableSnapshot = MutableStateFlow(snapshot(spec, previousPages))
  val snapshots = mutableSnapshot.asStateFlow()
  val current: OverlayRuntimeSnapshot
    get() = snapshots.value

  fun replace(spec: OverlaySpec) {
    if (!current.active) return
    val next = snapshot(spec, current.pages)
    val changed =
      (current.state.keys + next.state.keys).filter { key ->
        current.state[key] != next.state[key] &&
          (current.state[key] is OverlayScalar.Text || next.state[key] is OverlayScalar.Text)
      }
    mutableSnapshot.value =
      next.copy(
        textEpochs =
          current.textEpochs + changed.associateWith { (current.textEpochs[it] ?: 0) + 1 }
      )
  }

  fun close() {
    mutableSnapshot.value = current.copy(active = false)
  }

  suspend fun handle(interaction: OverlayInteraction) {
    if (!current.active) return
    when (interaction) {
      OverlayInteraction.HostDismiss -> dismiss()
      is OverlayInteraction.Tap -> tap(interaction.actions)
      is OverlayInteraction.PagerMotion ->
        if (!interaction.scrolling) setPage(interaction.pager, interaction.page)
      is OverlayInteraction.SettledPage -> setPage(interaction.pager, interaction.page)
      is OverlayInteraction.TextChange -> textChange(interaction)
      is OverlayInteraction.Select -> {
        if (interaction.pager != null) setPage(interaction.pager, interaction.index)
        else
          interaction.key?.let { change(it, OverlayScalar.Numeric(interaction.index.toDouble())) }
        tap(interaction.actions)
      }
      is OverlayInteraction.SheetDismiss -> {
        val condition = interaction.condition
        if (current.state[condition.key] == OverlayScalar.BooleanValue(condition.equals))
          change(condition.key, OverlayScalar.BooleanValue(!condition.equals))
      }
    }
  }

  private suspend fun tap(actions: List<OverlayAction>) {
    for (action in actions) {
      if (!current.active) break
      when (action) {
        is OverlayEmitAction -> emit(OverlayEventKind.EMIT, action.name, action.payload)
        is OverlaySetStateAction -> setState(action.key, action.value)
        is OverlayToggleAction -> action.nextValue(current.state)?.let { setState(action.key, it) }
        is OverlayIncrementAction ->
          action.nextValue(current.state)?.let { setState(action.key, it) }
        is OverlaySetPageAction -> {
          val page = current.pages[action.pager] ?: continue
          setPage(
            action.pager,
            when (val target = action.page) {
              OverlayPageTarget.Next -> page + 1
              OverlayPageTarget.Prev -> page - 1
              is OverlayPageTarget.Index -> target.index
            },
          )
        }
        OverlayDismissAction -> dismiss()
      }
    }
  }

  private suspend fun setPage(id: String, requested: Int) {
    val count = pagerCounts(current.spec.root)[id] ?: return
    val page = requested.coerceIn(0, count - 1)
    if (current.pages[id] == page) return
    mutableSnapshot.value = current.copy(pages = current.pages + (id to page))
    emit(OverlayEventKind.PAGE_CHANGED)
  }

  private fun setState(key: String, value: OverlayScalar) {
    val spec = current.spec.copy(state = current.state + (key to value))
    // Reuse the structured protocol validator to enforce keys, numeric ranges and binding types.
    val validation =
      OverlaySpecValidator.validate(runtimeJson.encodeToString(OverlaySpec.serializer(), spec))
    require(validation is OverlaySpecValidation.Success) {
      (validation as? OverlaySpecValidation.Failure)?.error.toString()
    }
    mutableSnapshot.value = current.copy(spec = spec)
  }

  /**
   * An edit the validator rejects (e.g. the spec size cap) leaves the state untouched, so the field
   * that already shows it must be told to revert: the key's epoch moves, the field adopts the
   * accepted text, and edits still in flight from the abandoned text go stale. Rethrown so the
   * controller still logs the failure (never the typed text).
   */
  private suspend fun textChange(interaction: OverlayInteraction.TextChange) {
    val key = interaction.key
    if (interaction.epoch < (current.textEpochs[key] ?: 0)) return
    try {
      change(key, OverlayScalar.Text(interaction.value))
    } catch (error: IllegalArgumentException) {
      mutableSnapshot.value =
        current.copy(textEpochs = current.textEpochs + (key to (current.textEpochs[key] ?: 0) + 1))
      throw error
    }
  }

  /** Changes emit once only for a changed value; setState actions and wire patches are silent. */
  private suspend fun change(key: String, value: OverlayScalar) {
    if (current.state[key] == value) return
    setState(key, value)
    emit(
      OverlayEventKind.EMIT,
      "change",
      buildJsonObject {
        put("key", key)
        put("value", runtimeJson.encodeToJsonElement(OverlayScalar.serializer(), value))
      },
    )
  }

  suspend fun dismiss(reason: OverlayDismissReason = OverlayDismissReason.USER) =
    withContext(NonCancellable) {
      if (!current.active) return@withContext
      check(requestDismiss()) { "Overlay host failed to dismiss window" }
      finishDismissal(reason)
    }

  /** Teardown is terminal even if the platform removal or event delivery fails. */
  internal suspend fun finishDismissal(reason: OverlayDismissReason) {
    if (!current.active) return
    close()
    emit(OverlayEventKind.DISMISSED, payload = buildJsonObject { put("reason", reason.wireValue) })
  }

  private suspend fun emit(
    kind: OverlayEventKind,
    name: String? = null,
    payload: JsonElement? = null,
  ) {
    sink.send(
      OverlayEvent(
        clock(),
        current.spec.id,
        nextSequence(),
        kind,
        name,
        payload,
        current.state.toMap(),
        current.pages.toMap(),
      )
    )
  }

  private fun snapshot(spec: OverlaySpec, previous: Map<String, Int>) =
    OverlayRuntimeSnapshot(
      spec,
      pagerCounts(spec.root).mapValues { (id, count) ->
        (previous[id] ?: 0).coerceIn(0, count - 1)
      },
    )
}

private val runtimeJson = Json { classDiscriminator = "type" }

internal fun overlayDescendants(node: OverlayNode): List<OverlayNode> =
  when (node) {
    is OverlayBoxNode -> node.children
    is OverlayRowNode -> node.children
    is OverlayColumnNode -> node.children
    is OverlayPagerNode -> node.children
    is OverlayScrollNode -> listOf(node.child)
    is OverlayBottomSheetNode -> listOf(node.child)
    else -> emptyList()
  }

internal fun pagerCounts(root: OverlayNode): Map<String, Int> = buildMap {
  fun visit(node: OverlayNode) {
    if (node is OverlayPagerNode) put(node.id, node.children.size)
    overlayDescendants(node).forEach(::visit)
  }
  visit(root)
}

/**
 * Detents retain author order; snapping uses physical height. All dimensions are window-local dp.
 */
fun overlaySheetHeights(detents: List<OverlayDetent>, windowHeight: Double): List<Double> =
  detents.map { detent ->
    when (detent) {
      OverlayDetent.Half -> windowHeight / 2
      OverlayDetent.Full -> windowHeight
      is OverlayDetent.Dp -> detent.dp.coerceAtMost(windowHeight)
    }
  }

/** Positive drag is downward. Below half the smallest detent dismisses if swipe dismissal is on. */
fun settleOverlaySheet(
  heights: List<Double>,
  current: Double,
  drag: Double,
  dismissOnSwipe: Boolean,
): Double? {
  val desired = current - drag
  if (dismissOnSwipe && desired < heights.min() / 2) return null
  return heights.minBy { kotlin.math.abs(it - desired) }
}
