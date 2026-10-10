package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*

fun interface PrototypeEventSink {
  suspend fun send(event: PrototypeEvent)
}

data class PrototypeRuntimeSnapshot(
  val spec: PrototypeSpec,
  val pages: Map<String, Int>,
  val active: Boolean = true,
  /**
   * Bumped per key each time the controller's text for that key is replaced from outside the field:
   * an authoritative patch that changes it, or a rejected edit that must be reverted. The field
   * adopts the value whenever the epoch moves; see [TextChange].
   */
  val textEpochs: Map<String, Int> = emptyMap(),
) {
  val state: Map<String, PrototypeScalar>
    get() = spec.state.orEmpty()
}

sealed interface PrototypeInteraction {
  data object HostDismiss : PrototypeInteraction

  data class Tap(val actions: List<PrototypeAction>) : PrototypeInteraction

  data class PagerMotion(val pager: String, val page: Int, val scrolling: Boolean) :
    PrototypeInteraction

  data class SettledPage(val pager: String, val page: Int) : PrototypeInteraction

  /**
   * [epoch] is the key's [PrototypeRuntimeSnapshot.textEpochs] entry the editing field last
   * rendered. An edit typed against text an authoritative [PrototypeRuntime.replace] has since
   * replaced is stale and is dropped, so the external value wins over reports still in flight.
   */
  data class TextChange(val key: String, val value: String, val epoch: Int = 0) :
    PrototypeInteraction

  data class Select(
    val pager: String?,
    val key: String?,
    val index: Int,
    val actions: List<PrototypeAction> = emptyList(),
  ) : PrototypeInteraction

  data class SheetDismiss(val condition: PrototypeSheetCondition) : PrototypeInteraction

  /** A `switch` or `checkbox` tap: flips the bound boolean, then runs the node's own actions. */
  data class Toggle(val key: String, val actions: List<PrototypeAction> = emptyList()) :
    PrototypeInteraction

  /** A `radioGroup` option tap: binds the string key to the option's value, then runs actions. */
  data class Choose(
    val key: String,
    val value: String,
    val actions: List<PrototypeAction> = emptyList(),
  ) : PrototypeInteraction

  /**
   * A `dialog` or `snackbar` button: closes its container by making [condition] false, then runs
   * the button's actions.
   */
  data class CloseModal(
    val condition: PrototypeSheetCondition,
    val actions: List<PrototypeAction> = emptyList(),
  ) : PrototypeInteraction

  /** A `timePicker` change: stores both bound keys, emitting one `change` event, then actions. */
  data class SetTime(
    val hourKey: String,
    val minuteKey: String,
    val hour: Int,
    val minute: Int,
    val actions: List<PrototypeAction> = emptyList(),
  ) : PrototypeInteraction

  /** A `slider` drag or accessibility set-progress: stores the (already snapped) number. */
  data class Slide(
    val key: String,
    val value: Double,
    val actions: List<PrototypeAction> = emptyList(),
  ) : PrototypeInteraction
}

/**
 * Device-free transitions, called serially by the controller. Only settled pager positions enter
 * this layer: intermediate fling frames never mutate pages or emit. Snapshots are immutable.
 * Sequence allocation precedes delivery, so a disconnected/dropping sink still consumes a number.
 * Dismissal finishes removal/delivery even if disposing Compose cancels the gesture coroutine.
 * Dismissal closes the runtime before delivery; its dismissed event is the final permitted event.
 */
class PrototypeRuntime(
  spec: PrototypeSpec,
  private val sink: PrototypeEventSink = PrototypeEventSink {},
  private val clock: () -> Long = System::currentTimeMillis,
  private val nextSequence: () -> Long,
  private val requestDismiss: suspend () -> Boolean = { true },
  previousPages: Map<String, Int> = emptyMap(),
) {
  private val mutableSnapshot = MutableStateFlow(snapshot(spec, previousPages))
  val snapshots = mutableSnapshot.asStateFlow()
  val current: PrototypeRuntimeSnapshot
    get() = snapshots.value

  fun replace(spec: PrototypeSpec) {
    if (!current.active) return
    val next = snapshot(spec, current.pages)
    val changed =
      (current.state.keys + next.state.keys).filter { key ->
        current.state[key] != next.state[key] &&
          (current.state[key] is PrototypeScalar.Text || next.state[key] is PrototypeScalar.Text)
      }
    mutableSnapshot.value =
      next.copy(
        textEpochs =
          current.textEpochs + changed.associateWith { (current.textEpochs[it] ?: 0) + 1 },
      )
  }

  fun close() {
    mutableSnapshot.value = current.copy(active = false)
  }

  suspend fun handle(interaction: PrototypeInteraction) {
    if (!current.active) return
    when (interaction) {
      PrototypeInteraction.HostDismiss -> dismiss()
      is PrototypeInteraction.Tap -> tap(interaction.actions)
      is PrototypeInteraction.PagerMotion ->
        if (!interaction.scrolling) setPage(interaction.pager, interaction.page)
      is PrototypeInteraction.SettledPage -> setPage(interaction.pager, interaction.page)
      is PrototypeInteraction.TextChange -> textChange(interaction)
      is PrototypeInteraction.Select -> {
        if (interaction.pager != null) setPage(interaction.pager, interaction.index)
        else
          interaction.key?.let { change(it, PrototypeScalar.Numeric(interaction.index.toDouble())) }
        tap(interaction.actions)
      }
      is PrototypeInteraction.SheetDismiss -> close(interaction.condition)
      is PrototypeInteraction.CloseModal -> {
        close(interaction.condition)
        tap(interaction.actions)
      }
      is PrototypeInteraction.SetTime -> setTime(interaction)
      is PrototypeInteraction.Toggle -> {
        // The validator keeps the bound key boolean; anything else leaves the control inert.
        val stored = current.state[interaction.key] as? PrototypeScalar.BooleanValue ?: return
        change(interaction.key, PrototypeScalar.BooleanValue(!stored.value))
        tap(interaction.actions)
      }
      is PrototypeInteraction.Choose -> {
        // The validator keeps the bound key a string; anything else leaves the group inert.
        if (current.state[interaction.key] !is PrototypeScalar.Text) return
        change(interaction.key, PrototypeScalar.Text(interaction.value))
        tap(interaction.actions)
      }
      is PrototypeInteraction.Slide -> {
        val stored = current.state[interaction.key] as? PrototypeScalar.Numeric ?: return
        if (stored.value == interaction.value) return
        change(interaction.key, PrototypeScalar.Numeric(interaction.value))
        tap(interaction.actions)
      }
    }
  }

  /**
   * Runs an action list in order. If any `setState`/`toggle`/`increment` changed state, exactly one
   * `change` event carrying the final state follows the last action (#10622); `emit` actions fire
   * in order with the state as it was at that point. A list that nets no change emits nothing.
   *
   * The list is atomic (#11408): every state write is validated by [plannedWrites] before the first
   * action runs, so a list holding a write the validator rejects throws with nothing applied and
   * nothing emitted. The host mirrors device state through events and is never left behind by a
   * half-applied tap.
   */
  private suspend fun tap(actions: List<PrototypeAction>) {
    val writes = plannedWrites(actions)
    val baseline = current.state
    val touched = LinkedHashSet<String>()
    for ((index, action) in actions.withIndex()) {
      if (!current.active) break
      when (action) {
        is PrototypeEmitAction -> emit(PrototypeEventKind.EMIT, action.name, action.payload)
        is PrototypeSetPageAction -> {
          val page = current.pages[action.pager] ?: continue
          setPage(
            action.pager,
            when (val target = action.page) {
              PrototypePageTarget.Next -> page + 1
              PrototypePageTarget.Prev -> page - 1
              is PrototypePageTarget.Index -> target.index
            },
          )
        }
        PrototypeDismissAction -> dismiss()
        else ->
          writes[index]?.let { (key, spec) ->
            mutableSnapshot.value = current.copy(spec = spec)
            touched += key
          }
      }
    }
    if (current.active) emitStateChange(touched.filter { baseline[it] != current.state[it] })
  }

  /**
   * The validated spec each state action of [actions] leaves behind, by action index, with the key
   * it writes. Nothing is applied here. Actions after a `dismiss` never run, so they are not
   * planned; a toggle or step that is a no-op has no entry. Throws [IllegalArgumentException] for
   * the first write the validator rejects.
   */
  private fun plannedWrites(actions: List<PrototypeAction>): Map<Int, Pair<String, PrototypeSpec>> {
    var spec = current.spec
    val writes = HashMap<Int, Pair<String, PrototypeSpec>>()
    for ((index, action) in actions.withIndex()) {
      if (action == PrototypeDismissAction) break
      val (key, value) = action.stateWrite(spec.state.orEmpty()) ?: continue
      spec = validated(spec, mapOf(key to value))
      writes[index] = key to spec
    }
    return writes
  }

  private suspend fun close(condition: PrototypeSheetCondition) {
    if (current.state[condition.key] == PrototypeScalar.BooleanValue(condition.equals))
      change(condition.key, PrototypeScalar.BooleanValue(!condition.equals))
  }

  /** Both keys change together, so a new time reports one `change` event, never a half-set one. */
  private suspend fun setTime(interaction: PrototypeInteraction.SetTime) {
    val keys = listOf(interaction.hourKey, interaction.minuteKey)
    // The validator keeps both keys numeric; anything else leaves the picker inert.
    if (keys.any { current.state[it] !is PrototypeScalar.Numeric }) return
    val baseline = current.state
    val next =
      mapOf(
        interaction.hourKey to PrototypeScalar.Numeric(interaction.hour.toDouble()),
        interaction.minuteKey to PrototypeScalar.Numeric(interaction.minute.toDouble()),
      )
    if (next.all { (key, value) -> baseline[key] == value }) return
    setStates(next)
    emitStateChange(keys.filter { baseline[it] != current.state[it] })
    tap(interaction.actions)
  }

  /**
   * One key keeps the `{key, value}` payload of [change]. Several keys cannot fit it, so they send
   * `{keys, values}` instead; the event's `state` always carries the full final state.
   */
  private suspend fun emitStateChange(keys: List<String>) {
    if (keys.isEmpty()) return
    val state = current.state
    fun json(key: String) =
      runtimeJson.encodeToJsonElement(PrototypeScalar.serializer(), state.getValue(key))
    val payload = buildJsonObject {
      if (keys.size == 1) {
        put("key", keys.single())
        put("value", json(keys.single()))
      } else {
        put("keys", buildJsonArray { keys.forEach { add(JsonPrimitive(it)) } })
        put("values", buildJsonObject { keys.forEach { put(it, json(it)) } })
      }
    }
    emit(PrototypeEventKind.EMIT, "change", payload)
  }

  private suspend fun setPage(id: String, requested: Int) {
    val count = pagerCounts(current.spec.root)[id] ?: return
    val page = requested.coerceIn(0, count - 1)
    if (current.pages[id] == page) return
    mutableSnapshot.value = current.copy(pages = current.pages + (id to page))
    emit(PrototypeEventKind.PAGE_CHANGED)
  }

  private fun setState(key: String, value: PrototypeScalar) = setStates(mapOf(key to value))

  private fun setStates(values: Map<String, PrototypeScalar>) {
    mutableSnapshot.value = current.copy(spec = validated(current.spec, values))
  }

  /** [from] with [values] written, or [IllegalArgumentException] when the result is not valid. */
  private fun validated(from: PrototypeSpec, values: Map<String, PrototypeScalar>): PrototypeSpec {
    val spec = from.copy(state = from.state.orEmpty() + values)
    // Reuse the structured protocol validator to enforce keys, numeric ranges and binding types.
    val validation =
      PrototypeSpecValidator.validate(runtimeJson.encodeToString(PrototypeSpec.serializer(), spec))
    require(validation is PrototypeSpecValidation.Success) {
      (validation as? PrototypeSpecValidation.Failure)?.error.toString()
    }
    return spec
  }

  /**
   * An edit the validator rejects (e.g. the spec size cap) leaves the state untouched, so the field
   * that already shows it must be told to revert: the key's epoch moves, the field adopts the
   * accepted text, and edits still in flight from the abandoned text go stale. Rethrown so the
   * controller still logs the failure (never the typed text).
   */
  private suspend fun textChange(interaction: PrototypeInteraction.TextChange) {
    val key = interaction.key
    if (interaction.epoch < (current.textEpochs[key] ?: 0)) return
    try {
      change(key, PrototypeScalar.Text(interaction.value))
    } catch (error: IllegalArgumentException) {
      mutableSnapshot.value =
        current.copy(textEpochs = current.textEpochs + (key to (current.textEpochs[key] ?: 0) + 1))
      throw error
    }
  }

  /**
   * Changes emit once only for a changed value; wire patches are silent. A tap's action list
   * reports its own mutations via [tap].
   */
  private suspend fun change(key: String, value: PrototypeScalar) {
    if (current.state[key] == value) return
    setState(key, value)
    emit(
      PrototypeEventKind.EMIT,
      "change",
      buildJsonObject {
        put("key", key)
        put("value", runtimeJson.encodeToJsonElement(PrototypeScalar.serializer(), value))
      },
    )
  }

  suspend fun dismiss(reason: PrototypeDismissReason = PrototypeDismissReason.USER) =
    withContext(NonCancellable) {
      if (!current.active) return@withContext
      check(requestDismiss()) { "Prototype host failed to dismiss window" }
      finishDismissal(reason)
    }

  /** Teardown is terminal even if the platform removal or event delivery fails. */
  internal suspend fun finishDismissal(reason: PrototypeDismissReason) {
    if (!current.active) return
    close()
    emit(
      PrototypeEventKind.DISMISSED,
      payload = buildJsonObject { put("reason", reason.wireValue) },
    )
  }

  /**
   * The resolved light or dark mode changed while shown. The controller decides when; this only
   * allocates the next sequence and sends the event, like every other one.
   */
  internal suspend fun appearanceChanged(appearance: PrototypeAppearance) {
    if (!current.active) return
    emit(
      PrototypeEventKind.APPEARANCE_CHANGED,
      payload =
        buildJsonObject {
          put("mode", runtimeJson.encodeToJsonElement(appearance.mode))
          put("source", runtimeJson.encodeToJsonElement(appearance.source))
        },
    )
  }

  private suspend fun emit(
    kind: PrototypeEventKind,
    name: String? = null,
    payload: JsonElement? = null,
  ) {
    sink.send(
      PrototypeEvent(
        clock(),
        current.spec.id,
        nextSequence(),
        kind,
        name,
        payload,
        current.state.toMap(),
        current.pages.toMap(),
      ),
    )
  }

  private fun snapshot(spec: PrototypeSpec, previous: Map<String, Int>) =
    PrototypeRuntimeSnapshot(
      spec,
      pagerCounts(spec.root).mapValues { (id, count) ->
        (previous[id] ?: 0).coerceIn(0, count - 1)
      },
    )
}

private val runtimeJson = Json { classDiscriminator = "type" }

internal fun prototypeDescendants(node: PrototypeNode): List<PrototypeNode> =
  when (node) {
    is PrototypeBoxNode -> node.children
    is PrototypeRowNode -> node.children
    is PrototypeColumnNode -> node.children
    is PrototypePagerNode -> node.children
    is PrototypeCardNode -> node.children
    is PrototypeScrollNode -> listOf(node.child)
    is PrototypeBottomSheetNode -> listOf(node.child)
    is PrototypeDialogNode -> listOfNotNull(node.child)
    else -> emptyList()
  }

internal fun pagerCounts(root: PrototypeNode): Map<String, Int> = buildMap {
  fun visit(node: PrototypeNode) {
    if (node is PrototypePagerNode) put(node.id, node.children.size)
    prototypeDescendants(node).forEach(::visit)
  }
  visit(root)
}

/**
 * Detents retain author order; snapping uses physical height. All dimensions are window-local dp.
 */
fun prototypeSheetHeights(detents: List<PrototypeDetent>, windowHeight: Double): List<Double> =
  detents.map { detent ->
    when (detent) {
      PrototypeDetent.Half -> windowHeight / 2
      PrototypeDetent.Full -> windowHeight
      is PrototypeDetent.Dp -> detent.dp.coerceAtMost(windowHeight)
    }
  }

/** Positive drag is downward. Below half the smallest detent dismisses if swipe dismissal is on. */
fun settlePrototypeSheet(
  heights: List<Double>,
  current: Double,
  drag: Double,
  dismissOnSwipe: Boolean,
): Double? {
  val desired = current - drag
  if (dismissOnSwipe && desired < heights.min() / 2) return null
  return heights.minBy { kotlin.math.abs(it - desired) }
}
