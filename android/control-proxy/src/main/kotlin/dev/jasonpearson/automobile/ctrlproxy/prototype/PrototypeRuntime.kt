package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.util.Log
import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.CancellationException
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
  val revision: Long = 0L,
  /** Removed keys keep their stamp so a stale add cannot resurrect them unnoticed. */
  val stateRevisions: Map<String, Long> = emptyMap(),
  val stacks: Map<String, PrototypeStackSnapshot> = emptyMap(),
) {
  val state: Map<String, PrototypeScalar>
    get() = spec.state.orEmpty()
}

sealed interface PrototypeInteraction {
  data object HostDismiss : PrototypeInteraction

  data object Back : PrototypeInteraction

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
  initialRevision: Long = 0L,
  private val nextRevision: (() -> Long)? = null,
  previousStacks: Map<String, PrototypeStackSnapshot> = emptyMap(),
) {
  @Volatile private var stateWriteValidator: PrototypeStateWriteValidator? = null
  internal var prepareStateWrites: (PrototypeSpec) -> PrototypeStateWriteValidator = {
    PrototypeSpecValidator.prepareStateWrites(it, runtimeJson)
  }

  private val renderMapper = PrototypeRenderMapper()

  internal fun renderModel(snapshot: PrototypeRuntimeSnapshot = current): PrototypeRenderModel =
    renderMapper.map(snapshot.spec, snapshot.pages, snapshot.stacks)

  internal val renderMappingPasses: Int
    get() = renderMapper.mappingPasses

  private val mutableSnapshot =
    MutableStateFlow(
      snapshot(spec, previousPages, previousStacks)
        .copy(
          revision = initialRevision,
          stateRevisions = spec.state.orEmpty().keys.associateWith { initialRevision },
        ),
    )
  val snapshots = mutableSnapshot.asStateFlow()
  val current: PrototypeRuntimeSnapshot
    get() = snapshots.value

  fun replace(spec: PrototypeSpec) {
    if (!current.active) return
    stateWriteValidator = null
    mutableSnapshot.value = replacementSnapshot(spec)
  }

  /** Authoritative text replacement shares its epoch handling with patch commits. */
  private fun replacementSnapshot(spec: PrototypeSpec): PrototypeRuntimeSnapshot {
    val before = current
    val next = snapshot(spec, before.pages, before.stacks)
    val changed =
      (before.state.keys + next.state.keys).filter { key ->
        before.state[key] != next.state[key] &&
          (before.state[key] is PrototypeScalar.Text || next.state[key] is PrototypeScalar.Text)
      }
    return next.copy(
      textEpochs = before.textEpochs + changed.associateWith { (before.textEpochs[it] ?: 0) + 1 },
      revision = before.revision,
      stateRevisions = before.stateRevisions,
    )
  }

  sealed interface PatchResult {
    data class Applied(val revision: Long) : PatchResult

    data class Conflict(val revision: Long, val state: Map<String, PrototypeScalar>) : PatchResult

    data class Rejected(val message: String, val revision: Long) : PatchResult
  }

  /** Plans and validates against live state, then commits into this same runtime. */
  suspend fun patch(
    baseRevision: Long?,
    ops: JsonArray,
    json: Json,
    validate: (JsonObject) -> PrototypeSpec,
  ): PatchResult {
    val before = current
    if (!before.active) return PatchResult.Rejected("Prototype is inactive", before.revision)
    if (PrototypePatch.touchesState(ops)) {
      if (baseRevision == null) {
        return PatchResult.Rejected(
          "baseRevision is required when a patch has /state ops",
          before.revision,
        )
      }
      if (baseRevision > before.revision) {
        return PatchResult.Rejected(
          "baseRevision $baseRevision is newer than the device revision ${before.revision}",
          before.revision,
        )
      }
      val changed =
        ops
          .mapNotNull { op ->
            val path = (op as? JsonObject)?.get("path") as? JsonPrimitive
            if (path?.isString == true && path.content.startsWith("/state/")) {
              PrototypeDataPointer.tokens(path.content.removePrefix("/state")).firstOrNull()
            } else null
          }
          .distinct()
          .filter { key -> before.stateRevisions[key]?.let { it > baseRevision } == true }
      if (changed.isNotEmpty()) {
        return PatchResult.Conflict(before.revision, before.state.filterKeys { it in changed })
      }
    }
    val patched =
      when (
        val result =
          PrototypePatch.apply(
            json.encodeToJsonElement(before.spec),
            ops,
            PrototypePatch.StateTests.EVALUATE,
          )
      ) {
        is PrototypePatch.Result.Failure ->
          return PatchResult.Rejected(
            "${result.error.path}: ${result.error.message}",
            before.revision,
          )
        is PrototypePatch.Result.Success -> result.spec
      }
    val spec =
      try {
        validate(patched).also {
          require(
            it.id == before.spec.id &&
              it.window == before.spec.window &&
              it.theme == before.spec.theme,
          ) {
            "Patch must keep prototype id, window and theme"
          }
        }
      } catch (error: CancellationException) {
        throw error
      } catch (error: Exception) {
        return PatchResult.Rejected(error.message ?: "Invalid prototype patch", before.revision)
      }
    val changed =
      (before.state.keys + spec.state.orEmpty().keys).filter {
        before.state[it] != spec.state.orEmpty()[it]
      }
    val next = replacementSnapshot(spec)
    // Validate Compose sizes with a disposable mapper so rejected candidates cannot alter the
    // runtime's resolve cache, cached model or renderMappingPasses before the snapshot is
    // committed.
    try {
      PrototypeRenderMapper().map(next.spec, next.pages, next.stacks)
    } catch (error: IllegalArgumentException) {
      return PatchResult.Rejected(error.message ?: "Invalid prototype patch", before.revision)
    }
    val revision = allocateRevision()
    stateWriteValidator = null
    mutableSnapshot.value =
      next.copy(
        revision = revision,
        stateRevisions = before.stateRevisions + changed.associateWith { revision },
      )
    // The commit is authoritative even if an ancillary event sink fails. Cancellation propagates.
    try {
      emitStateChange(changed.filter { it in current.state })
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      Log.w("PrototypeRuntime", "Prototype patch change delivery failed", error)
    }
    return PatchResult.Applied(revision)
  }

  private fun allocateRevision(): Long = nextRevision?.invoke() ?: (current.revision + 1L)

  fun close() {
    mutableSnapshot.value = current.copy(active = false)
  }

  suspend fun handle(interaction: PrototypeInteraction) {
    if (!current.active) return
    try {
      handleInteraction(interaction)
    } finally {
      interactionRevision = null
    }
  }

  private var interactionRevision: Long? = null

  /** Every accepted state write in one interaction shares a revision, even if a key is restored. */
  private fun writeInteractionSpec(spec: PrototypeSpec) {
    val changed =
      (current.state.keys + spec.state.orEmpty().keys).filter {
        current.state[it] != spec.state.orEmpty()[it]
      }
    if (changed.isEmpty()) return
    val revision = interactionRevision ?: allocateRevision().also { interactionRevision = it }
    mutableSnapshot.value =
      current.copy(
        spec = spec,
        revision = revision,
        stateRevisions = current.stateRevisions + changed.associateWith { revision },
      )
  }

  private suspend fun handleInteraction(interaction: PrototypeInteraction) {
    when (interaction) {
      PrototypeInteraction.HostDismiss -> dismiss()
      // Hidden screens retain their paths but cannot take stack Back focus. If none is visible and
      // eligible, preserve the existing Back dismissal rather than changing a hidden screen.
      PrototypeInteraction.Back -> if (!popTopmostStack()) dismiss()
      is PrototypeInteraction.Tap -> control(emptyMap(), interaction.actions)
      is PrototypeInteraction.PagerMotion ->
        if (!interaction.scrolling) setPage(interaction.pager, interaction.page)
      is PrototypeInteraction.SettledPage -> setPage(interaction.pager, interaction.page)
      is PrototypeInteraction.TextChange -> textChange(interaction)
      is PrototypeInteraction.Select -> select(interaction)
      is PrototypeInteraction.SheetDismiss -> control(closing(interaction.condition), emptyList())
      is PrototypeInteraction.CloseModal ->
        control(closing(interaction.condition), interaction.actions)
      is PrototypeInteraction.SetTime -> setTime(interaction)
      is PrototypeInteraction.Toggle -> {
        // The validator keeps the bound key boolean; anything else leaves the control inert.
        val stored = current.state[interaction.key] as? PrototypeScalar.BooleanValue ?: return
        control(
          mapOf(interaction.key to PrototypeScalar.BooleanValue(!stored.value)),
          interaction.actions,
        )
      }
      is PrototypeInteraction.Choose -> {
        // The validator keeps the bound key a string; anything else leaves the group inert.
        if (current.state[interaction.key] !is PrototypeScalar.Text) return
        control(
          mapOf(interaction.key to PrototypeScalar.Text(interaction.value)),
          interaction.actions,
        )
      }
      is PrototypeInteraction.Slide -> {
        val stored = current.state[interaction.key] as? PrototypeScalar.Numeric ?: return
        if (stored.value == interaction.value) return
        control(
          mapOf(interaction.key to PrototypeScalar.Numeric(interaction.value)),
          interaction.actions,
        )
      }
    }
  }

  /**
   * One interaction as one unit (#11408): the control's [own] write (a switch flip, a chosen
   * option, a closed dialog; empty for a plain tap) and every state write of its [actions] are
   * validated before anything is applied, so a rejected interaction throws with nothing applied and
   * nothing emitted. The host mirrors device state through events and is never left behind by a
   * half-applied interaction.
   *
   * An accepted one reports as the iOS agent does: the control's own `change` first, when its value
   * moved, then the action list via [run].
   */
  private suspend fun control(own: Map<String, PrototypeScalar>, actions: List<PrototypeAction>) {
    val moved = own.filter { (key, value) -> current.state[key] != value }
    val written = if (moved.isEmpty()) current.spec else validated(current.spec, moved)
    val writes = plannedWrites(actions, written)
    if (moved.isNotEmpty()) {
      writeInteractionSpec(written)
      emitStateChange(moved.keys.toList())
    }
    run(actions, writes)
  }

  /**
   * A `tabBar`/`bottomNav` selection: drives its pager, else its state key, then runs the actions.
   * The pager only moves once the action list is known to be accepted.
   */
  private suspend fun select(interaction: PrototypeInteraction.Select) {
    val pager = interaction.pager
    if (pager == null) {
      val index = PrototypeScalar.Numeric(interaction.index.toDouble())
      control(interaction.key?.let { mapOf(it to index) }.orEmpty(), interaction.actions)
      return
    }
    val writes = plannedWrites(interaction.actions, current.spec)
    setPage(pager, interaction.index)
    run(interaction.actions, writes)
  }

  /**
   * Runs an action list in order, applying the [writes] planned for it. If any
   * `setState`/`toggle`/`increment` changed state, exactly one `change` event carrying the final
   * state follows the last action (#10622); `emit` actions fire in order with the state as it was
   * at that point. A list that nets no change emits nothing.
   */
  private suspend fun run(
    actions: List<PrototypeAction>,
    writes: Map<Int, Pair<String, PrototypeSpec>>,
  ) {
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
        is PrototypePushAction ->
          changeStack(action.stack) { node, path ->
            if (
              path.size >= PrototypeSpecValidator.MAX_PROTOTYPE_STACK_DEPTH ||
                !node.screens.containsKey(action.screen)
            )
              path
            else path + action.screen
          }
        is PrototypePopAction ->
          changeStack(action.stack) { _, path ->
            if (path.size == 1) path else path.dropLast(1)
          }
        is PrototypePopToRootAction -> changeStack(action.stack) { node, _ -> listOf(node.start) }
        is PrototypeReplaceAction ->
          changeStack(action.stack) { node, path ->
            if (!node.screens.containsKey(action.screen)) path else path.dropLast(1) + action.screen
          }
        PrototypeDismissAction -> dismiss()
        else ->
          writes[index]?.let { (key, spec) ->
            writeInteractionSpec(spec)
            touched += key
          }
      }
    }
    if (current.active) emitStateChange(touched.filter { baseline[it] != current.state[it] })
  }

  /**
   * The validated spec each state action of [actions] leaves behind when the list starts from
   * [from], by action index, with the key it writes. Nothing is applied here. Actions after a
   * `dismiss` never run, so they are not planned; a toggle or step that is a no-op has no entry.
   * Throws [IllegalArgumentException] for the first write the validator rejects.
   */
  private fun plannedWrites(
    actions: List<PrototypeAction>,
    from: PrototypeSpec,
  ): Map<Int, Pair<String, PrototypeSpec>> {
    var spec = from
    val writes = HashMap<Int, Pair<String, PrototypeSpec>>()
    for ((index, action) in actions.withIndex()) {
      if (action == PrototypeDismissAction) break
      val (key, value) = action.stateWrite(spec.state.orEmpty()) ?: continue
      spec = validated(spec, mapOf(key to value))
      writes[index] = key to spec
    }
    return writes
  }

  /**
   * The write that makes [condition] false, closing its sheet, dialog or snackbar, if it is open.
   */
  private fun closing(condition: PrototypeSheetCondition): Map<String, PrototypeScalar> =
    if (current.state[condition.key] == PrototypeScalar.BooleanValue(condition.equals))
      mapOf(condition.key to PrototypeScalar.BooleanValue(!condition.equals))
    else emptyMap()

  /** Both keys change together, so a new time reports one `change` event, never a half-set one. */
  private suspend fun setTime(interaction: PrototypeInteraction.SetTime) {
    val next =
      mapOf(
        interaction.hourKey to PrototypeScalar.Numeric(interaction.hour.toDouble()),
        interaction.minuteKey to PrototypeScalar.Numeric(interaction.minute.toDouble()),
      )
    // The validator keeps both keys numeric; anything else leaves the picker inert.
    if (next.keys.any { current.state[it] !is PrototypeScalar.Numeric }) return
    if (next.all { (key, value) -> current.state[key] == value }) return
    control(next, interaction.actions)
  }

  /**
   * One key keeps the `{key, value}` payload. Several keys cannot fit it, so they send `{keys,
   * values}` instead; the event's `state` always carries the full final state.
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
    // Names the pager that moved and its new page, as the iOS agent does (#11409).
    emit(PrototypeEventKind.PAGE_CHANGED, id, JsonPrimitive(page))
  }

  /** Framework-free Back policy; the controller serializes this with other interactions. */
  suspend fun popTopmostStack(): Boolean {
    if (!current.active) return false
    val id = stackPopTarget(renderModel().root, current.stacks) ?: return false
    changeStack(id) { _, path -> path.dropLast(1) }
    return true
  }

  /** Focus and Back dispatch use exactly the same visible target selection. */
  fun hasPoppableStack(model: PrototypeRenderModel = renderModel()): Boolean =
    current.active && stackPopTarget(model.root, current.stacks) != null

  private fun stackPopTarget(
    root: PrototypeRenderNode,
    stacks: Map<String, PrototypeStackSnapshot>,
  ): String? {
    var target: String? = null
    fun visit(node: PrototypeRenderNode) {
      if (!node.visible || node.role in PROTOTYPE_MODAL_ROLES) return
      val stack = node.source as? PrototypeStackNode
      if (stack != null && (stacks[stack.id]?.depth ?: 1) > 1) target = stack.id
      // Visit parents before children: a nested top-screen stack wins over its ancestor.
      // Among siblings the last eligible stack in document order wins, matching render order.
      val children =
        if (node.role == "pager") listOfNotNull(node.children.getOrNull(node.page))
        else node.children
      children.forEach(::visit)
    }
    visit(root)
    // Hoisted modals render last; stacks in their visible bodies take Back before inline ones.
    modalPrototypeSheets(root).forEach { modal -> modal.children.forEach(::visit) }
    return target
  }

  private suspend fun changeStack(
    id: String,
    transform: (PrototypeStackNode, List<String>) -> List<String>,
  ) {
    val node = stackNodes(current.spec.root)[id] ?: return
    val before = current.stacks[id] ?: return
    val path = transform(node, before.path)
    if (path == before.path) return
    val next = PrototypeStackSnapshot(path.toList())
    mutableSnapshot.value = current.copy(stacks = current.stacks + (id to next))
    if (before.path.last() != path.last() || before.depth != next.depth) {
      emit(
        PrototypeEventKind.SCREEN_CHANGED,
        id,
        buildJsonObject {
          put("screen", path.last())
          put("depth", next.depth)
        },
      )
    }
  }

  /** [from] with [values] written, or [IllegalArgumentException] when the result is not valid. */
  private fun validated(from: PrototypeSpec, values: Map<String, PrototypeScalar>): PrototypeSpec =
    PrototypeTrace.section(PrototypeTrace.VALIDATE_STATE_WRITE) {
      val spec = from.copy(state = from.state.orEmpty() + values)
      val validator =
        stateWriteValidator
          ?: PrototypeTrace.section(PrototypeTrace.PREPARE_STATE_WRITES) {
            prepareStateWrites(from).also { stateWriteValidator = it }
          }
      val error = validator.validate(checkNotNull(spec.state))
      require(error == null) { error.toString() }
      spec
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
      control(mapOf(key to PrototypeScalar.Text(interaction.value)), emptyList())
    } catch (error: IllegalArgumentException) {
      mutableSnapshot.value =
        current.copy(textEpochs = current.textEpochs + (key to (current.textEpochs[key] ?: 0) + 1))
      throw error
    }
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
        current.stacks.toMap(),
      ),
    )
  }

  private fun snapshot(
    spec: PrototypeSpec,
    previous: Map<String, Int>,
    previousStacks: Map<String, PrototypeStackSnapshot>,
  ) =
    PrototypeRuntimeSnapshot(
      spec,
      pagerCounts(spec.root).mapValues { (id, count) ->
        (previous[id] ?: 0).coerceIn(0, count - 1)
      },
      stacks =
        stackNodes(spec.root).mapValues { (id, node) ->
          val path =
            previousStacks[id]
              ?.path
              .orEmpty()
              .filter { node.screens.containsKey(it) }
              .take(PrototypeSpecValidator.MAX_PROTOTYPE_STACK_DEPTH)
          PrototypeStackSnapshot(path.ifEmpty { listOf(node.start) })
        },
    )
}

private val runtimeJson = Json { classDiscriminator = "type" }

internal fun prototypeDescendants(node: PrototypeNode): List<PrototypeNode> =
  when (node) {
    is PrototypeBoxNode -> node.children
    is PrototypeRowNode -> node.children
    is PrototypeColumnNode -> node.children
    is PrototypeFlowNode -> node.children
    is PrototypeGridNode -> node.children
    is PrototypePagerNode -> node.children
    is PrototypeStackNode -> node.screens.values.toList()
    is PrototypeCardNode -> node.children
    is PrototypeScrollNode -> listOf(node.child)
    is PrototypeBottomSheetNode -> listOf(node.child)
    is PrototypeDialogNode -> listOfNotNull(node.child)
    is PrototypeSearchBarNode -> listOfNotNull(node.child)
    else -> emptyList()
  }

internal fun stackNodes(root: PrototypeNode): Map<String, PrototypeStackNode> = buildMap {
  fun visit(node: PrototypeNode) {
    if (node is PrototypeStackNode) put(node.id, node)
    prototypeDescendants(node).forEach(::visit)
  }
  visit(root)
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
