package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.util.Log
import dev.jasonpearson.automobile.protocol.*
import dev.jasonpearson.automobile.prototype.PlatformCallResult
import dev.jasonpearson.automobile.prototype.PlatformError
import dev.jasonpearson.automobile.prototype.PlatformErrorCode
import dev.jasonpearson.automobile.prototype.PrototypePlatform as RuntimePlatform
import dev.jasonpearson.automobile.prototype.PrototypePlatformRegistry
import java.util.UUID
import kotlin.math.floor
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*

@InternalAutoMobilePrototypeApi
fun interface PrototypeEventSink {
  suspend fun send(event: PrototypeEvent)
}

@InternalAutoMobilePrototypeApi
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
  val stackChange: PrototypeStackChange? = null,
  /** Device-local error visibility, cleared on spec replacement. */
  val shownErrors: Set<String> = emptySet(),
  /** The latest `scrollTo` per scroll id (#14232); the scroll performs each once. */
  val scrollRequests: Map<String, PrototypeScrollRequest> = emptyMap(),
  val platformState: JsonObject = JsonObject(emptyMap()),
  val locales: List<String> = emptyList(),
) {
  val state: Map<String, PrototypeScalar>
    get() = spec.state.orEmpty()
}

@InternalAutoMobilePrototypeApi
sealed interface PrototypeInteraction {
  /** Device observation and restored pager positions do not extend the host's idle expiry. */
  fun countsAsUserActivity(pages: Map<String, Int>): Boolean =
    this !is DeviceState && (this !is PagerMotion || scrolling || pages[pager] != page)

  data class Guarded(val identity: String, val interaction: PrototypeInteraction) :
    PrototypeInteraction

  data class Blur(val keys: List<String>) : PrototypeInteraction

  data object HostDismiss : PrototypeInteraction

  data object Back : PrototypeInteraction

  data class Tap(val actions: List<PrototypeAction>) : PrototypeInteraction

  data class DeviceState(val snapshot: JsonObject) : PrototypeInteraction

  data class TimerFire(val actions: List<PrototypeAction>) : PrototypeInteraction

  data class DeadTap(val xDp: Float, val yDp: Float) : PrototypeInteraction

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
@InternalAutoMobilePrototypeApi
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
  /** Where a refused data write is explained; a seam so JVM tests need no `android.util.Log`. */
  private val warn: (String) -> Unit = { Log.w("PrototypeRuntime", it) },
  /**
   * Keeps the spec's `storage` keys across shows (#12522). The [spec] passed in already carries the
   * restored values, so restoring is neither a write nor an event.
   */
  @InternalAutoMobilePrototypeApi val storage: PrototypeStorageSession? = null,
  /** The transports behind `request` actions (#12528); a seam so JVM tests use a fake. */
  private val httpClients: PrototypeHttpClients = PrototypeHttpClients.Unavailable,
  /**
   * Where `request` actions wait for their response. The runtime cancels its own requests on
   * dismissal and never this scope; tests pass a test scope to control time.
   */
  private val requestScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
  /**
   * Runs a request's completion alongside the interactions: the controller passes its own lock so a
   * response never lands in the middle of a tap. The default runs it directly.
   */
  private val exclusively: suspend (suspend () -> Unit) -> Unit = { it() },
  /** A request id is unique on the device and stable between the request and its response. */
  private val newRequestId: () -> String = { UUID.randomUUID().toString() },
  /** The device-wide cap on requests in flight; the controller shares one across its surfaces. */
  private val requestLimiter: PrototypeRequestLimiter = PrototypeRequestLimiter(),
  initialPlatformState: JsonObject = JsonObject(emptyMap()),
  val shaderSession: PrototypeShaderSession = PrototypeShaderSession(),
  platform: RuntimePlatform = RuntimePlatform.None,
  platformLimiter: PrototypeRequestLimiter =
    PrototypeRequestLimiter(PrototypePlatformCalls.maxInFlight),
) {
  @Volatile private var stateWriteValidator: PrototypeStateWriteValidator? = null
  internal var prepareStateWrites: (PrototypeSpec) -> PrototypeStateWriteValidator = {
    PrototypeSpecValidator.prepareStateWrites(it, runtimeJson)
  }

  // A runtime is owned by one show; list disposal during navigation never clears its signatures.
  internal val listEndTriggers = PrototypeListEndTriggers()

  private val timerEngine =
    PrototypeTimers(clock, requestScope, exclusively) { actions ->
      handle(PrototypeInteraction.TimerFire(actions))
    }

  private var appeared = emptySet<String>()
  private var appearanceRoot: PrototypeNode? = null
  private var hasAppearances = false

  /** Called only after the host accepts the show. A preserving replacement seeds without firing. */
  suspend fun shown(preservingState: Boolean = false) {
    appeared = if (preservingState) visibleAppearances().keys else emptySet()
    if (!preservingState) handle(PrototypeInteraction.TimerFire(emptyList()))
  }

  private fun visibleAppearances(): Map<String, List<PrototypeAction>> {
    val root = current.spec.root
    if (appearanceRoot !== root) {
      fun contains(node: PrototypeNode): Boolean =
        node.onAppear != null || prototypeDescendants(node).any(::contains)
      appearanceRoot = root
      hasAppearances = contains(root)
    }
    if (!current.active || !hasAppearances) return emptyMap()
    return buildMap {
      fun visit(node: PrototypeRenderNode) {
        if (!node.visible) return
        if (node.role in PROTOTYPE_MODAL_ROLES && !node.sheetOpen) return
        node.source?.onAppear?.let { put(node.identity, it) }
        val children =
          if (node.role == "pager") listOfNotNull(node.children.getOrNull(node.page))
          else node.children
        children.forEach(::visit)
      }
      visit(renderModel().root)
    }
  }

  /** One appearance per identity per interaction, with the contract's existing nesting bound. */
  private suspend fun runAppearances() {
    val ran = mutableSetOf<String>()
    repeat(PrototypeSpecValidator.MAX_PROTOTYPE_ACTION_DEPTH) {
      val visible = visibleAppearances()
      val entering = visible.filterKeys { it !in appeared }
      appeared = visible.keys.toSet()
      if (entering.isEmpty()) return
      for ((identity, actions) in entering) {
        if (!current.active) return
        if (identity !in visibleAppearances()) continue
        if (!ran.add(identity)) {
          warn("Refused repeated onAppear at $identity within one interaction")
          continue
        }
        try {
          control(emptyMap(), actions)
        } catch (error: IllegalArgumentException) {
          warn("Refused onAppear at $identity: ${error.message}")
        }
      }
    }
    appeared = visibleAppearances().keys.toSet()
    warn("onAppear action nesting limit reached")
  }

  fun pauseTimers() = timerEngine.pause()

  fun resumeTimers() = timerEngine.resume()

  fun timerReports(): List<PrototypeTimerReport> = timerEngine.reports()

  suspend fun advanceClock(ms: Int): Int = timerEngine.advance(ms)

  private val platformState =
    PrototypePlatformState(CoroutinePrototypeScheduler(requestScope), exclusively) { name, data ->
        deliverPlatformEvent(name, data)
      }
      .also { if (initialPlatformState.isNotEmpty()) it.update(initialPlatformState) }
  private var eventData: JsonObject? = null

  private suspend fun deliverPlatformEvent(name: String, data: JsonObject) {
    if (!current.active || name.substringBefore('.') !in current.spec.requires?.platform.orEmpty())
      return
    val previousEvent = eventData
    eventData = data
    try {
      handle(PrototypeInteraction.Tap(current.spec.platform?.on?.get(name).orEmpty()))
    } finally {
      eventData = previousEvent
    }
    if (!current.active) return
    var payload = buildJsonObject {
      put("event", name)
      put("data", data)
    }
    if (
      payload.toString().toByteArray(Charsets.UTF_8).size >
        PrototypeSpecValidator.MAX_PROTOTYPE_EMIT_PAYLOAD_BYTES
    ) {
      payload = buildJsonObject {
        put("event", name)
        put("data", JsonObject(emptyMap()))
        put("truncated", true)
      }
    }
    emit(PrototypeEventKind.EMIT, PrototypePlatform.DELIVERED_EVENT_NAME, payload)
  }

  private val renderMapper =
    PrototypeRenderMapper(AndroidPrototypeValueFormatter(clock = PrototypeClock(clock)))

  /** The running animations of this prototype's window, published in its window metadata. */
  @InternalAutoMobilePrototypeApi val motionActivity = PrototypeMotionActivity()

  /** Effects that stopped animating over the frame budget (#15129), reported by `inspect`. */
  @InternalAutoMobilePrototypeApi val effectHealth = PrototypeEffectHealth()

  @InternalAutoMobilePrototypeApi
  fun renderModel(snapshot: PrototypeRuntimeSnapshot = current): PrototypeRenderModel =
    renderMapper.map(
      snapshot.spec,
      snapshot.pages,
      snapshot.stacks,
      snapshot.shownErrors,
      snapshot.platformState,
      snapshot.locales,
    )

  internal val renderMappingPasses: Int
    get() = renderMapper.mappingPasses

  private val mutableSnapshot =
    MutableStateFlow(
      snapshot(spec, previousPages, previousStacks)
        .copy(
          platformState = platformState.snapshot,
          revision = initialRevision,
          stateRevisions = spec.state.orEmpty().keys.associateWith { initialRevision },
        ),
    )
  val snapshots = mutableSnapshot.asStateFlow()
  val current: PrototypeRuntimeSnapshot
    get() = snapshots.value

  private val deviceModule =
    PrototypeDeviceModule(initialPlatformState["device"] as? JsonObject ?: JsonObject(emptyMap()))
  val platformRegistry =
    PrototypePlatformRegistry(
      listOf(deviceModule) + platform.registry.modules,
    )
  private val platformDispatcher =
    PrototypePlatformDispatcher(
      platformRegistry,
      requestScope,
      exclusively,
      newRequestId,
      clock,
      ::finishPlatformCall,
      ::deliverPlatformEvent,
      ::publishModuleState,
      warn,
      platformLimiter,
    )

  /** Start streams only after the host has installed this runtime in its surface table. */
  fun startPlatformModules() = platformDispatcher.subscribe()

  /** Hosts call this under their lock before replacement, reset or dismissal. */
  suspend fun cancelPlatformCalls() = platformDispatcher.cancel()

  private fun publishModuleState(name: String, state: JsonObject) {
    if (!current.active || (name == "device" && state.isEmpty())) return
    val next = JsonObject(current.platformState + (name to state))
    if (next.toString().toByteArray(Charsets.UTF_8).size > PrototypeDeviceContract.maxStateBytes) {
      warn("Refused oversized platform state from $name")
      return
    }
    mutableSnapshot.value = current.copy(platformState = next)
  }

  /** A locale-only change publishes a new snapshot so every host maps fresh text. */
  fun updateLocales(locales: List<String>) {
    if (current.locales != locales) mutableSnapshot.value = current.copy(locales = locales.toList())
  }

  fun replace(spec: PrototypeSpec) {
    if (!current.active) return
    stateWriteValidator = null
    mutableSnapshot.value = replacementSnapshot(spec)
  }

  /** Authoritative text replacement shares its epoch handling with patch commits. */
  private fun replacementSnapshot(spec: PrototypeSpec): PrototypeRuntimeSnapshot {
    val before = current
    val next = snapshot(spec, before.pages, before.stacks).copy(locales = before.locales)
    val changed =
      (before.state.keys + next.state.keys).filter { key ->
        before.state[key] != next.state[key] &&
          (before.state[key] is PrototypeScalar.Text || next.state[key] is PrototypeScalar.Text)
      }
    return next.copy(
      textEpochs = before.textEpochs + changed.associateWith { (before.textEpochs[it] ?: 0) + 1 },
      revision = before.revision,
      stateRevisions = before.stateRevisions,
      platformState = before.platformState,
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
    val next = replacementSnapshot(spec)
    val changed =
      (before.state.keys + next.state.keys).filter {
        before.state[it] != next.state[it]
      }
    // Validate Compose sizes with a disposable mapper so rejected candidates cannot alter the
    // runtime's resolve cache, cached model or renderMappingPasses before the snapshot is
    // committed.
    try {
      PrototypeRenderMapper(AndroidPrototypeValueFormatter(clock = PrototypeClock(clock)))
        .map(next.spec, next.pages, stacks = next.stacks, shownErrors = next.shownErrors)
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
    storage?.record(current.spec)
    try {
      emitStateChange(changed.filter { it in current.state })
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      Log.w("PrototypeRuntime", "Prototype patch change delivery failed", error)
    }
    runAppearances()
    return PatchResult.Applied(current.revision)
  }

  private fun allocateRevision(): Long = nextRevision?.invoke() ?: (current.revision + 1L)

  fun close() {
    platformDispatcher.close()
    platformState.close()
    mutableSnapshot.value = current.copy(active = false)
    timerEngine.cancelAll()
    cancelRequests()
  }

  suspend fun handle(interaction: PrototypeInteraction) {
    if (!current.active) return
    try {
      handleInteraction(interaction)
      runAppearances()
    } finally {
      interactionRevision = null
      // Every device write ends an interaction here, so one diff covers state, data and checks.
      if (current.active) storage?.record(current.spec)
    }
  }

  /** Writes any stored value not yet on disk: the dismissal and replacement path. */
  suspend fun flushStorage() {
    storage?.flush()
  }

  private var interactionRevision: Long? = null

  /** Every accepted state write in one interaction shares a revision, even if a key is restored. */
  private fun writeInteractionSpec(spec: PrototypeSpec) {
    val spec = normalizePagerState(spec)
    val changed =
      (current.state.keys + spec.state.orEmpty().keys).filter {
        current.state[it] != spec.state.orEmpty()[it]
      }
    if (changed.isEmpty()) return
    val revision = interactionRevision ?: allocateRevision().also { interactionRevision = it }
    // Only state differs from the spec the write was planned against. Taking the planned spec whole
    // would roll back a data write made earlier in the same action list.
    mutableSnapshot.value =
      current.copy(
        spec = current.spec.copy(state = spec.state),
        pages = boundPages(spec, current.pages),
        revision = revision,
        stateRevisions = current.stateRevisions + changed.associateWith { revision },
      )
  }

  private fun updateDeviceState(snapshot: JsonObject) {
    if (platformState.update(snapshot)) {
      deviceModule.update(platformState.snapshot.getValue("device").jsonObject)
      publishModuleState("device", platformState.snapshot.getValue("device").jsonObject)
    }
  }

  private suspend fun handleInteraction(interaction: PrototypeInteraction) {
    when (interaction) {
      is PrototypeInteraction.DeviceState -> updateDeviceState(interaction.snapshot)
      is PrototypeInteraction.Guarded -> {
        fun find(node: PrototypeRenderNode): PrototypeRenderNode? =
          if (node.identity == interaction.identity) node
          else node.childrenForIdentity(interaction.identity).firstNotNullOfOrNull(::find)
        val node = find(renderModel().root) ?: return
        if (node.enabled || interaction.interaction is PrototypeInteraction.Blur)
          handle(interaction.interaction)
      }
      is PrototypeInteraction.Blur -> {
        val keys =
          checkedNodes()
            .filter { it.validationMode() == PrototypeValidateOn.BLUR }
            .flatMap { it.checkedKeys() }
            .filter { it in interaction.keys }
        mutableSnapshot.value = current.copy(shownErrors = current.shownErrors + keys)
      }
      PrototypeInteraction.HostDismiss -> dismiss()
      // Hidden screens retain their paths but cannot take stack Back focus. If none is visible and
      // eligible, preserve the existing Back dismissal rather than changing a hidden screen.
      PrototypeInteraction.Back -> if (!popTopmostStack()) dismiss()
      is PrototypeInteraction.Tap -> control(emptyMap(), interaction.actions)
      is PrototypeInteraction.TimerFire -> {
        try {
          control(emptyMap(), interaction.actions)
        } catch (error: IllegalArgumentException) {
          warn("Refused timer fire: ${error.message}")
        }
      }
      is PrototypeInteraction.DeadTap -> deadTap(interaction)
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
    if (!requireValid(actions)) return
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
    if (!requireValid(interaction.actions)) return
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
    val plannedData = current.spec.data
    val touched = LinkedHashSet<String>()
    for ((index, action) in actions.withIndex()) {
      if (!current.active) break
      when (action) {
        is PrototypeEmitAction -> emitAction(action)
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
          changeStack(action.stack, "push", action.stackTransition) { node, path ->
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
          changeStack(action.stack, "replace", action.stackTransition) { node, path ->
            if (!node.screens.containsKey(action.screen)) path else path.dropLast(1) + action.screen
          }
        PrototypeDismissAction -> dismiss()
        is PrototypeSetDataAction,
        is PrototypeAppendDataAction,
        is PrototypePrependDataAction,
        is PrototypeRemoveDataAction -> writeData(action)
        is PrototypeRequestAction -> startRequest(action, touched)
        is PrototypePlatformAction -> startPlatformCall(action, touched)
        is PrototypeScrollToAction -> requestScroll(action)
        is PrototypeStartTimerAction -> timerEngine.start(action)
        is PrototypeCancelTimerAction -> timerEngine.cancel(action.id)
        else ->
          writes[index]?.let { (key, planned) ->
            // A data write earlier in this list may have added rows that bind this key, so a
            // value planned against the old data is checked again against the data as it is now.
            if (current.spec.data === plannedData) writeInteractionSpec(planned)
            else
              writeInteractionSpec(
                validated(current.spec, mapOf(key to planned.state.orEmpty().getValue(key))),
              )
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
    val changedChecks =
      checkedNodes()
        .filter { it.validationMode() == PrototypeValidateOn.CHANGE }
        .flatMap { it.checkedKeys() }
        .filter { it in keys }
    mutableSnapshot.value = current.copy(shownErrors = current.shownErrors + changedChecks)
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
    emit(kind = PrototypeEventKind.EMIT, name = "change", payload = payload)
  }

  private var scrollSequence = 0L

  /**
   * Queues a `scrollTo` for its scroll to perform; scrolling is not a state change and emits
   * nothing.
   */
  private fun requestScroll(action: PrototypeScrollToAction) {
    val target = PrototypeScrollTarget.of(action.to) ?: return
    val request = PrototypeScrollRequest(target, action.animated ?: true, ++scrollSequence)
    mutableSnapshot.value =
      current.copy(scrollRequests = current.scrollRequests + (action.scroll to request))
  }

  private suspend fun setPage(id: String, requested: Int) {
    val count = pagerCounts(current.spec.root)[id] ?: return
    val page = requested.coerceIn(0, count - 1)
    if (current.pages[id] == page) return
    val key = pagerNodes(current.spec.root)[id]?.stateKey
    val changed = key != null && current.state[key] != PrototypeScalar.Numeric(page.toDouble())
    if (key != null && changed)
      writeInteractionSpec(
        validated(current.spec, mapOf(key to PrototypeScalar.Numeric(page.toDouble()))),
      )
    mutableSnapshot.value = current.copy(pages = current.pages + (id to page))
    // Names the pager that moved and its new page, as the iOS agent does (#11409).
    emit(kind = PrototypeEventKind.PAGE_CHANGED, name = id, payload = JsonPrimitive(page))
    if (key != null && changed) emitStateChange(listOf(key))
  }

  private suspend fun deadTap(tap: PrototypeInteraction.DeadTap) {
    if (current.spec.window.deadTaps != true) return
    val top =
      current.stacks.entries.minWithOrNull(
        compareByDescending<Map.Entry<String, PrototypeStackSnapshot>> { it.value.path.size }
          .thenBy { it.key },
      )
    emit(
      kind = PrototypeEventKind.EMIT,
      name = PrototypeDeadTaps.EVENT_NAME,
      payload =
        buildJsonObject {
          put("stack", top?.key?.let(::JsonPrimitive) ?: JsonNull)
          put("screen", top?.value?.path?.lastOrNull()?.let(::JsonPrimitive) ?: JsonNull)
          put("x", roundHalfUp(tap.xDp.toDouble()))
          put("y", roundHalfUp(tap.yDp.toDouble()))
        },
    )
  }

  /** Framework-free Back policy; the controller serializes this with other interactions. */
  suspend fun popTopmostStack(): Boolean {
    if (!current.active) return false
    val root = renderModel().root
    val drawer = modalPrototypeSheets(root).lastOrNull { it.role == "drawer" }
    if (drawer != null) {
      control(closing((drawer.source as PrototypeDrawerNode).openWhen), emptyList())
      return true
    }
    val id = stackPopTarget(root, current.stacks) ?: return false
    changeStack(id) { _, path -> path.dropLast(1) }
    return true
  }

  /** Focus and Back dispatch use exactly the same visible target selection. */
  fun hasPoppableStack(model: PrototypeRenderModel = renderModel()): Boolean =
    current.active &&
      (modalPrototypeSheets(model.root).any { it.role == "drawer" } ||
        stackPopTarget(model.root, current.stacks) != null)

  internal fun backPreview(): PrototypeRuntimeSnapshot? {
    if (modalPrototypeSheets(renderModel().root).any { it.role == "drawer" }) return null
    val id = stackPopTarget(renderModel().root, current.stacks) ?: return null
    val stack = current.stacks.getValue(id)
    return current.copy(
      stacks = current.stacks + (id to PrototypeStackSnapshot(stack.path.dropLast(1))),
      stackChange = PrototypeStackChange(id, "pop"),
    )
  }

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
    direction: String = "pop",
    override: PrototypeStackTransition? = null,
    transform: (PrototypeStackNode, List<String>) -> List<String>,
  ) {
    val node = stackNodes(current.spec.root)[id] ?: return
    val before = current.stacks[id] ?: return
    val path = transform(node, before.path)
    if (path == before.path) return
    val next = PrototypeStackSnapshot(path.toList())
    mutableSnapshot.value =
      current.copy(
        stacks = current.stacks + (id to next),
        stackChange =
          PrototypeStackChange(id, direction, override, (current.stackChange?.sequence ?: 0) + 1),
      )
    if (before.path.last() != path.last() || before.depth != next.depth) {
      emit(
        kind = PrototypeEventKind.SCREEN_CHANGED,
        name = id,
        payload =
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
      val spec = normalizePagerState(from.copy(state = from.state.orEmpty() + values))
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
  @InternalAutoMobilePrototypeApi
  suspend fun finishDismissal(reason: PrototypeDismissReason) {
    if (!current.active) return
    storage?.record(current.spec)
    storage?.flush()
    cancelPlatformCalls()
    close()
    emit(
      kind = PrototypeEventKind.DISMISSED,
      payload = buildJsonObject { put("reason", reason.wireValue) },
    )
  }

  /**
   * The resolved light or dark mode changed while shown. The controller decides when; this only
   * allocates the next sequence and sends the event, like every other one.
   */
  @InternalAutoMobilePrototypeApi
  suspend fun appearanceChanged(appearance: PrototypeAppearance) {
    if (!current.active) return
    emit(
      kind = PrototypeEventKind.APPEARANCE_CHANGED,
      payload =
        buildJsonObject {
          put("mode", runtimeJson.encodeToJsonElement(appearance.mode))
          put("source", runtimeJson.encodeToJsonElement(appearance.source))
        },
    )
  }

  /** Bindings read the committed values at the action, after the writes before it in the list. */
  private fun bindingInputs() =
    object : EmitContextInputs {
      override fun state(key: String): JsonElement? =
        current.state[key]?.let(EmitContextResolver::scalar)

      override fun page(id: String): Int? = current.pages[id]

      override fun data(pointer: String): JsonElement? =
        PrototypeDataPointer.resolve(current.spec.data, pointer)

      override fun platform(pointer: String): JsonElement? =
        PrototypeDataPointer.resolve(current.platformState, pointer)

      override fun event(pointer: String): JsonElement? =
        PrototypeDataPointer.resolve(eventData, pointer)
    }

  /**
   * A `setData`, `appendData`, `prependData` or `removeData` action (#12519). The write is the
   * shared [PrototypeDataWriter] semantics, applied to an immutable copy of the data so Compose
   * sees a new spec; a refused write (typed error, or a result the renderer cannot take) changes
   * and emits nothing and the rest of the list still runs. An accepted write bumps the revision and
   * reports itself as a `change` event named by the written path.
   */
  private suspend fun writeData(action: PrototypeAction) {
    val write = dataWrite(action) ?: return
    applyDataWrite(write)?.let { refusedDataWrite(write, it.message) }
  }

  /**
   * One accepted or refused `/data` write; shared by the data actions and a request's response.
   * Null once the write took effect (and reported itself), else why it was refused.
   */
  private suspend fun applyDataWrite(write: PrototypeDataWrite): PrototypeDataWriteError? {
    val before = current
    val spec =
      when (val staged = stageDataWrite(before, before.spec, write)) {
        is StagedWrite.Accepted -> staged.spec
        is StagedWrite.Refused -> return staged.error
      }
    val revision = allocateRevision()
    // The next state write of this interaction allocates a later revision, so it never regresses.
    interactionRevision = null
    stateWriteValidator = null
    mutableSnapshot.value = before.copy(spec = spec, revision = revision)
    emit(
      kind = PrototypeEventKind.CHANGE,
      name = write.path,
      payload = dataWritePayload(write, revision),
    )
    return null
  }

  private sealed interface StagedWrite {
    class Accepted(val spec: PrototypeSpec) : StagedWrite

    class Refused(val error: PrototypeDataWriteError) : StagedWrite
  }

  /** [write] applied to [from] and checked against the renderer's limits; nothing is changed. */
  private fun stageDataWrite(
    before: PrototypeRuntimeSnapshot,
    from: PrototypeSpec,
    write: PrototypeDataWrite,
  ): StagedWrite {
    val data =
      when (val result = PrototypeDataWriter.apply(from.data, write)) {
        is PrototypeDataWriteResult.Success -> result.data
        is PrototypeDataWriteResult.Failure -> return StagedWrite.Refused(result.error)
      }
    prototypeListDataWriteError(from, data, write.path)?.let {
      return StagedWrite.Refused(
        PrototypeDataWriteError(PrototypeDataWriteErrorCode.INVALID_VALUE, it.message),
      )
    }
    val spec = from.copy(data = data)
    // Rows added by the write must still fit the renderer's limits; a disposable mapper keeps a
    // rejected write from touching the runtime's own caches, as for a patch.
    return try {
      PrototypeRenderMapper(AndroidPrototypeValueFormatter(clock = PrototypeClock(clock)))
        .map(spec, before.pages, stacks = before.stacks, shownErrors = before.shownErrors)
      StagedWrite.Accepted(spec)
    } catch (error: IllegalArgumentException) {
      StagedWrite.Refused(
        PrototypeDataWriteError(
          PrototypeDataWriteErrorCode.LIMIT_EXCEEDED,
          error.message ?: "Data write exceeds a prototype limit",
        ),
      )
    }
  }

  /** The first refusal of [writes] applied in order from now, or null; nothing is applied. */
  private fun trialDataWrites(writes: List<PrototypeDataWrite>): PrototypeDataWriteError? {
    val before = current
    var spec = before.spec
    for (write in writes) {
      when (val staged = stageDataWrite(before, spec, write)) {
        is StagedWrite.Accepted -> spec = staged.spec
        is StagedWrite.Refused -> return staged.error
      }
    }
    return null
  }

  private fun refusedDataWrite(write: PrototypeDataWrite, message: String) {
    warn("Refused ${write.op}Data at ${write.path}: $message")
  }

  /** Binds the action's value; null when the value cannot be resolved (the write is refused). */
  private fun dataWrite(action: PrototypeAction): PrototypeDataWrite? {
    fun value(binding: EmitContextBinding, path: String): JsonElement? =
      when (val resolved = PrototypeDataWriter.resolveValue(binding, bindingInputs())) {
        is PrototypeDataValue.Resolved -> resolved.value
        is PrototypeDataValue.Failure -> {
          warn("Refused data write at $path: ${resolved.error.message}")
          null
        }
      }
    return when (action) {
      is PrototypeSetDataAction ->
        value(action.value, action.path)?.let { PrototypeDataWrite.Set(action.path, it) }
      is PrototypeAppendDataAction ->
        value(action.value, action.path)?.let {
          PrototypeDataWrite.Append(
            action.path,
            it,
            prototypeListMaxItemsFor(current.spec, action.path),
          )
        }
      is PrototypePrependDataAction ->
        value(action.value, action.path)?.let {
          PrototypeDataWrite.Prepend(
            action.path,
            it,
            prototypeListMaxItemsFor(current.spec, action.path),
          )
        }
      is PrototypeRemoveDataAction -> PrototypeDataWrite.Remove(action.path)
      else -> null
    }
  }

  /**
   * `{op, value?, revision}`. The value is left out when the payload would not fit an event, so the
   * host, which cannot mirror a write it was not shown, stops tracking the spec.
   */
  private fun dataWritePayload(write: PrototypeDataWrite, revision: Long): JsonObject {
    fun payload(value: JsonElement?) = buildJsonObject {
      put("op", write.op)
      if (value != null) put("value", value)
      val maximum =
        when (write) {
          is PrototypeDataWrite.Append -> write.maxItems
          is PrototypeDataWrite.Prepend -> write.maxItems
          is PrototypeDataWrite.Extend -> write.maxItems
          else -> null
        }
      maximum?.let { put("maxItems", it.toLong()) }
      put("revision", revision)
    }
    val value =
      when (write) {
        is PrototypeDataWrite.Set -> write.value
        is PrototypeDataWrite.Append -> write.value
        is PrototypeDataWrite.Prepend -> write.value
        is PrototypeDataWrite.Extend -> write.value
        is PrototypeDataWrite.Remove -> null
      }
    val full = payload(value)
    return if (
      full.toString().toByteArray(Charsets.UTF_8).size <=
        PrototypeSpecValidator.MAX_PROTOTYPE_EMIT_PAYLOAD_BYTES
    )
      full
    else payload(null)
  }

  private suspend fun startPlatformCall(
    action: PrototypePlatformAction,
    touched: MutableSet<String>,
  ) {
    val args = linkedMapOf<String, JsonElement>()
    var invalid: String? = null
    for ((name, binding) in action.args.orEmpty()) {
      when (val resolved = PrototypeDataWriter.resolveValue(binding.jsonObject, bindingInputs())) {
        is PrototypeDataValue.Resolved -> args[name] = resolved.value
        is PrototypeDataValue.Failure -> {
          invalid = resolved.error.message
          break
        }
      }
    }
    // Resolve against the state before loading, matching request actions (including self-bindings).
    action.statusKey?.let { if (writeStatus(it, "loading")) touched += it }
    platformDispatcher.start(
      action,
      if (invalid == null) JsonObject(args) else null,
      invalid,
      eventData,
    )
  }

  private fun platformCallPayload(
    call: PrototypePlatformDispatcher.Pending,
    error: PlatformError?,
    durationMs: Long,
  ) = buildJsonObject {
    if (call.action.call.startsWith("clipboard.")) {
      put("op", call.action.call.substringAfter('.'))
      put("bytes", call.clipboardBytes)
    }
    put("callId", call.id)
    put("call", call.action.call)
    put("outcome", if (error == null) "success" else "error")
    put("durationMs", durationMs)
    error?.let { failure ->
      put(
        "error",
        buildJsonObject {
          put("code", failure.code.wireValue)
          put("message", failure.message.take(512))
        },
      )
    }
  }

  /** Writes a call's result and metadata under `into`; returns the error to report. */
  private suspend fun writePlatformResult(
    call: PrototypePlatformDispatcher.Pending,
    result: PlatformCallResult,
    error: PlatformError?,
    duration: Long,
  ): PlatformError? {
    val into = call.action.into ?: return error
    val writes = mutableListOf<PrototypeDataWrite>()
    if (result is PlatformCallResult.Success) writes += PrototypeDataWrite.Set(into, result.value)
    writes +=
      PrototypeDataWrite.Set(
        PrototypeRequests.metaPath(into),
        platformCallPayload(call, error, duration).let { JsonObject(it - "callId" - "call") },
      )
    val refused = trialDataWrites(writes)
    if (refused == null) {
      writes.forEach { applyDataWrite(it) }
      return error
    }
    val reported =
      error ?: PlatformError(PlatformErrorCode.PLATFORM_ERROR, refused.message.take(512))
    applyDataWrite(
      PrototypeDataWrite.Set(
        PrototypeRequests.metaPath(into),
        JsonObject(platformCallPayload(call, reported, duration) - "callId" - "call"),
      ),
    )
    return reported
  }

  private suspend fun runPlatformFollowUp(
    call: PrototypePlatformDispatcher.Pending,
    error: PlatformError?,
  ) {
    if (error?.code == PlatformErrorCode.CANCELLED) return
    val action = call.action
    val actions = (if (error == null) action.onSuccess else action.onError).orEmpty()
    if (actions.isEmpty() || !current.active || !requireValid(actions)) return
    val previousEvent = eventData
    eventData = call.eventContext
    try {
      run(actions, plannedWrites(actions, current.spec))
    } catch (refused: IllegalArgumentException) {
      warn("Refused platform follow-up: ${refused.message}")
    } finally {
      eventData = previousEvent
    }
  }

  private suspend fun finishPlatformCall(
    call: PrototypePlatformDispatcher.Pending,
    result: PlatformCallResult,
  ) {
    try {
      val initial = (result as? PlatformCallResult.Failure)?.error
      val duration = (clock() - call.startedAt).coerceAtLeast(0)
      if (!current.active) {
        if (initial?.code == PlatformErrorCode.CANCELLED) {
          val closed = PlatformError(PlatformErrorCode.CANCELLED, "Prototype closed")
          emit(
            PrototypeEventKind.EMIT,
            PrototypePlatform.CALL_EVENT_NAME,
            platformCallPayload(call, closed, duration),
          )
        }
        return
      }
      val error = writePlatformResult(call, result, initial, duration)
      call.action.statusKey?.let {
        if (writeStatus(it, if (error == null) "success" else "error")) emitStateChange(listOf(it))
      }
      emit(
        PrototypeEventKind.EMIT,
        PrototypePlatform.CALL_EVENT_NAME,
        platformCallPayload(call, error, duration),
      )
      runPlatformFollowUp(call, error)
    } finally {
      interactionRevision = null
      if (current.active) storage?.record(current.spec)
    }
  }

  // ---- request action (#12528) ----

  /** A started request, kept until its response settles or it is superseded or cancelled. */
  private class RequestInFlight(
    val requestId: String,
    val method: String,
    val url: String,
    val via: String,
    val into: String?,
    val statusKey: String?,
    val startedAt: Long,
    val onSuccess: List<PrototypeAction>?,
    val onError: List<PrototypeAction>?,
    val eventContext: JsonObject?,
    val append: PrototypeRequestAppend?,
  ) {
    lateinit var job: Job

    /** The runtime that applies the response; a same-id replacement hands it to the new one. */
    @Volatile lateinit var owner: PrototypeRuntime
  }

  private val inFlight = LinkedHashMap<String, RequestInFlight>()

  /** Dismissal ends every request without a trace: the runtime is closed, so nothing is sent. */
  private fun cancelRequests() {
    val jobs = synchronized(inFlight) { inFlight.values.map { it.job }.also { inFlight.clear() } }
    jobs.forEach {
      it.cancel()
      requestLimiter.release()
    }
  }

  /**
   * Hands the requests still in flight to [replacement], the runtime that replaces this one for the
   * same id without a reset: their responses then apply to the new spec through the normal outcome
   * path. Call before [close], which would cancel them.
   */
  @InternalAutoMobilePrototypeApi
  fun handOverRequests(replacement: PrototypeRuntime) {
    val moved = synchronized(inFlight) { inFlight.values.toList().also { inFlight.clear() } }
    moved.forEach { request ->
      requestLimiter.release()
      replacement.adoptRequest(request)
    }
  }

  private fun adoptRequest(request: RequestInFlight) {
    request.owner = this
    requestLimiter.acquire()
    synchronized(inFlight) { inFlight[request.requestId] = request }
  }

  /** `{data:/pointer}` and `{key}` placeholders read the committed data and state at the action. */
  private fun requestText(text: String): String =
    interpolatePrototypeText(
      PrototypeRequests.bindDataText(text, current.spec.data),
      current.state,
    )

  private fun requestEntries(entries: Map<String, JsonElement>?): Map<String, JsonElement>? =
    entries?.mapValues { (_, entry) ->
      if (entry is JsonPrimitive && entry.isString) JsonPrimitive(requestText(entry.content))
      else entry
    }

  /**
   * A `request` action: resolves its bindings against the committed state and data, moves
   * `statusKey` to `loading`, then waits for the response off the interaction. The latest request
   * with overlapping `into` or `append.to` targets wins (the older one reports `cancelled`), at
   * most [PrototypeSpecValidator.MAX_PROTOTYPE_REQUESTS_IN_FLIGHT] run at once, and a request that
   * cannot start finishes at once as an error. The response is applied by [finishRequest].
   */
  private suspend fun startRequest(action: PrototypeRequestAction, touched: MutableSet<String>) {
    val bound =
      action.copy(
        url = requestText(action.url),
        headers = requestEntries(action.headers),
        query = requestEntries(action.query),
      )
    val info = { url: String ->
      RequestInFlight(
        newRequestId(),
        action.method ?: PrototypeRequests.DEFAULT_METHOD,
        url,
        action.via ?: PrototypeHttpClients.VIA_HOST,
        action.into,
        action.statusKey,
        clock(),
        action.onSuccess,
        action.onError,
        eventData,
        action.append,
      )
    }
    // The newest request wins even when it fails to resolve: the older one must not land later.
    supersedeRequests(action.into, action.append?.to)
    val resolved =
      when (val result = PrototypeRequestResolver.resolve(bound, bound.url, bindingInputs())) {
        is PrototypeResolvedRequestResult.Failure ->
          return finishRequest(
            info(bound.url),
            PrototypeRequestResponse.Failed(result.error),
          )
        is PrototypeResolvedRequestResult.Success -> result.request
      }
    val started = info(resolved.url)
    started.owner = this
    if (!requestLimiter.tryAcquire()) {
      val error =
        PrototypeRequestError(
          PrototypeRequestErrorCode.TOO_MANY_IN_FLIGHT,
          "At most ${PrototypeSpecValidator.MAX_PROTOTYPE_REQUESTS_IN_FLIGHT} requests can be in flight.",
        )
      return finishRequest(started, PrototypeRequestResponse.Failed(error))
    }
    action.statusKey?.let { key ->
      if (writeStatus(key, PrototypeRequests.STATUS_LOADING)) touched += key
    }
    val request =
      PrototypeHttpRequest(
        requestId = started.requestId,
        prototypeId = current.spec.id,
        method = started.method,
        url = resolved.url,
        headers = resolved.headers,
        body = resolved.body,
        timeoutMs = action.timeoutMs ?: PrototypeSpecValidator.DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS,
      )
    val client = httpClients.forVia(started.via)
    // Lazy, so the job is registered before it can settle even on an eager dispatcher.
    started.job =
      requestScope.launch(start = CoroutineStart.LAZY) {
        val response =
          try {
            client.execute(request)
          } catch (error: CancellationException) {
            throw error
          } catch (error: Exception) {
            warn("Request ${started.requestId} failed: ${error.message}")
            PrototypeRequestResponse.Failed(
              PrototypeRequestError(
                PrototypeRequestErrorCode.NETWORK,
                error.message ?: error.javaClass.simpleName,
              ),
            )
          }
        // A same-id replacement can adopt the request while this waits for the lock: re-read the
        // owner inside it and, if it changed, settle again on the new one.
        do {
          val owner = started.owner
          owner.exclusively { if (started.owner === owner) owner.settleRequest(started, response) }
        } while (started.owner !== owner)
      }
    synchronized(inFlight) { inFlight[started.requestId] = started }
    started.job.start()
  }

  /** A newer request to overlapping write targets ends the older one without follow-ups. */
  private suspend fun supersedeRequests(into: String?, appendTo: String?) {
    val targets = listOfNotNull(into, appendTo)
    if (targets.isEmpty()) return
    val older =
      synchronized(inFlight) {
        inFlight.values
          .filter { old ->
            listOfNotNull(old.into, old.append?.to).any { target ->
              targets.any { PrototypeDataPointer.overlaps(target, it) }
            }
          }
          .also { it.forEach { old -> inFlight.remove(old.requestId) } }
      }
    for (request in older) {
      request.job.cancel()
      requestLimiter.release()
      val error =
        PrototypeRequestError(
          PrototypeRequestErrorCode.CANCELLED,
          "Superseded by a newer request to ${into ?: appendTo}",
        )
      sendRequestEvent(request, null, clock() - request.startedAt, error)
    }
  }

  /** Only a request still registered settles; a superseded or dismissed one is dropped. */
  private suspend fun settleRequest(request: RequestInFlight, response: PrototypeRequestResponse) {
    val registered =
      synchronized(inFlight) {
        (inFlight[request.requestId] === request).also {
          if (it) inFlight.remove(request.requestId)
        }
      }
    if (registered) requestLimiter.release()
    if (!registered || !current.active) return
    try {
      finishRequest(request, response)
      runAppearances()
    } finally {
      interactionRevision = null
      // A response writes outside handle(), so a stored key it changed is recorded here (#12522).
      if (current.active) storage?.record(current.spec)
    }
  }

  /**
   * The completion order of the contract: `into`, then `<into>__meta`, then `statusKey`, then the
   * `prototype_request` event, then `onSuccess` or `onError`.
   */
  private suspend fun finishRequest(request: RequestInFlight, response: PrototypeRequestResponse) {
    val writes = mutableListOf<PrototypeDataWrite>()
    val result =
      PrototypeRequestOutcome.complete(
        request.into,
        response,
        request.append?.let {
          it.copy(maxItems = prototypeListMaxItemsFor(current.spec, it.to)?.toLong())
        },
        ::trialDataWrites,
      ) { write ->
        writes += write
        null
      }
    // The outcome stages every write before any suspendable event delivery. The controller's
    // exclusive lock covers both this trial and the complete ordered commit.
    for (write in writes) {
      check(applyDataWrite(write) == null) { "A staged request write was refused at ${write.path}" }
    }
    if (!current.active) return
    request.statusKey?.let { key ->
      val status =
        if (result.succeeded) PrototypeRequests.STATUS_SUCCESS else PrototypeRequests.STATUS_ERROR
      if (writeStatus(key, status)) emitStateChange(listOf(key))
    }
    sendRequestEvent(
      request,
      result.meta.status,
      result.meta.durationMs,
      result.meta.error,
    )
    val followUps = (if (result.succeeded) request.onSuccess else request.onError).orEmpty()
    if (followUps.isEmpty() || !current.active || !requireValid(followUps)) return
    val followUpWrites =
      try {
        plannedWrites(followUps, current.spec)
      } catch (error: IllegalArgumentException) {
        warn("Refused the follow-up of request ${request.requestId}: ${error.message}")
        return
      }
    val previousEvent = eventData
    eventData = request.eventContext
    try {
      run(followUps, followUpWrites)
    } finally {
      eventData = previousEvent
    }
  }

  private suspend fun sendRequestEvent(
    request: RequestInFlight,
    status: Int?,
    durationMs: Long,
    error: PrototypeRequestError?,
  ) {
    emit(
      kind = PrototypeEventKind.EMIT,
      name = PrototypeRequests.EVENT_NAME,
      payload =
        PrototypeRequestEvent.payload(
          request.requestId,
          request.method,
          request.url,
          request.via,
          request.into,
          status,
          durationMs,
          error,
        ),
    )
  }

  /** True when the state key changed; a rejected write leaves state alone and says why. */
  private fun writeStatus(key: String, status: String): Boolean {
    val value = PrototypeScalar.Text(status)
    if (current.state[key] == value) return false
    return try {
      writeInteractionSpec(validated(current.spec, mapOf(key to value)))
      true
    } catch (error: IllegalArgumentException) {
      warn("Refused statusKey $key = $status: ${error.message}")
      false
    }
  }

  private suspend fun emitAction(action: PrototypeEmitAction) {
    val resolved =
      action.context?.let { bindings -> EmitContextResolver.resolve(bindings, bindingInputs()) }
    emit(
      kind = PrototypeEventKind.EMIT,
      name = action.name,
      payload = action.payload,
      resolved = resolved,
    )
  }

  private suspend fun emit(
    kind: PrototypeEventKind,
    name: String? = null,
    payload: JsonElement? = null,
    resolved: ResolvedEmitContext? = null,
    keys: List<String>? = null,
  ) {
    sink.send(
      PrototypeEvent(
        timestamp = clock(),
        id = current.spec.id,
        sequence = nextSequence(),
        kind = kind,
        name = name,
        payload = payload,
        state = current.state.toMap(),
        pages = current.pages.toMap(),
        stacks = current.stacks.toMap(),
        context = resolved?.context,
        contextTruncated = resolved?.contextTruncated,
        validity =
          if (name == "change" && kind == PrototypeEventKind.EMIT)
            validity().takeIf { it.isNotEmpty() }
          else null,
        keys = keys,
      ),
    )
  }

  private val checkedNodeCache =
    PrototypeCheckedNodeCache(AndroidPrototypeValueFormatter(clock = PrototypeClock(clock)))

  private fun checkedNodes(): List<PrototypeNode> = checkedNodeCache.nodes(current.spec)

  private fun validity(): Map<String, Boolean> = prototypeValidity(checkedNodes(), current.state)

  /** Guards use the pre-interaction state, before any writes or emits in the list. */
  private suspend fun requireValid(actions: List<PrototypeAction>): Boolean {
    val guarded =
      actions
        .takeWhile { it != PrototypeDismissAction }
        .filterIsInstance<PrototypeEmitAction>()
        .filter { it.requireValid != null }
    if (guarded.isEmpty()) return true
    val validity = validity()
    val failed = guarded.filter { action ->
      action.requireValid.orEmpty().any { validity[it] != true }
    }
    if (failed.isEmpty()) return true
    mutableSnapshot.value =
      current.copy(shownErrors = current.shownErrors + failed.flatMap { it.requireValid.orEmpty() })
    for (action in failed) {
      emit(
        kind = PrototypeEventKind.VALIDATION_FAILED,
        name = action.name,
        keys = action.requireValid.orEmpty().filter { validity[it] != true },
      )
    }
    return false
  }

  private fun snapshot(
    spec: PrototypeSpec,
    previous: Map<String, Int>,
    previousStacks: Map<String, PrototypeStackSnapshot>,
  ) =
    PrototypeRuntimeSnapshot(
      normalizePagerState(spec),
      boundPages(spec, previous),
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

  init {
    platform.registry.modules.forEach { publishModuleState(it.name, it.state.value) }
  }
}

private fun pagerNodes(root: PrototypeNode): Map<String, PrototypePagerNode> = buildMap {
  fun visit(node: PrototypeNode) {
    if (node is PrototypePagerNode) put(node.id, node)
    prototypeDescendants(node).forEach(::visit)
  }
  visit(root)
}

private fun boundPages(spec: PrototypeSpec, previous: Map<String, Int>): Map<String, Int> =
  pagerNodes(spec.root).mapValues { (id, node) ->
    val value = node.stateKey?.let { (spec.state?.get(it) as? PrototypeScalar.Numeric)?.value }
    (value?.coerceIn(0.0, (node.children.size - 1).toDouble())?.toInt() ?: previous[id] ?: 0)
      .coerceIn(0, node.children.size - 1)
  }

private fun normalizePagerState(spec: PrototypeSpec): PrototypeSpec {
  val original = spec.state ?: return spec
  val state = original.toMutableMap()
  for ((_, node) in pagerNodes(spec.root)) {
    val key = node.stateKey ?: continue
    val value = (state[key] as? PrototypeScalar.Numeric)?.value ?: continue
    if (value.isFinite() && value % 1.0 == 0.0)
      state[key] = PrototypeScalar.Numeric(value.coerceIn(0.0, (node.children.size - 1).toDouble()))
  }
  return if (state == original) spec else spec.copy(state = state)
}

private val runtimeJson = Json { classDiscriminator = "type" }

internal fun prototypeDescendants(node: PrototypeNode): List<PrototypeNode> =
  when (node) {
    is PrototypeBoxNode -> node.children
    is PrototypeRowNode -> node.children
    is PrototypeColumnNode -> node.children
    is PrototypeFlowNode -> node.children
    is PrototypeGridNode -> node.children
    is PrototypeCarouselNode -> node.children
    is PrototypePagerNode -> node.children
    is PrototypeStackNode -> node.screens.values.toList()
    is PrototypeCardNode -> node.children
    is PrototypeListNode -> listOfNotNull(node.header) + node.children + listOfNotNull(node.footer)
    is PrototypeScrollNode -> listOf(node.child)
    is PrototypeBottomSheetNode -> listOf(node.child)
    is PrototypeDrawerNode -> listOf(node.child)
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
internal fun prototypeSheetHeights(
  detents: List<PrototypeDetent>,
  windowHeight: Double,
): List<Double> = detents.map { detent ->
  when (detent) {
    PrototypeDetent.Half -> windowHeight / 2
    PrototypeDetent.Full -> windowHeight
    is PrototypeDetent.Dp -> detent.dp.coerceAtMost(windowHeight)
  }
}

/** Positive drag is downward. Below half the smallest detent dismisses if swipe dismissal is on. */
internal fun settlePrototypeSheet(
  heights: List<Double>,
  current: Double,
  drag: Double,
  dismissOnSwipe: Boolean,
): Double? {
  val desired = current - drag
  if (dismissOnSwipe && desired < heights.min() / 2) return null
  return heights.minBy { kotlin.math.abs(it - desired) }
}

/**
 * Counts the requests in flight against `MAX_PROTOTYPE_REQUESTS_IN_FLIGHT`. One instance is shared
 * by every runtime of a controller, so the cap holds for the device and not per window.
 */
@InternalAutoMobilePrototypeApi
class PrototypeRequestLimiter(
  private val max: Int = PrototypeSpecValidator.MAX_PROTOTYPE_REQUESTS_IN_FLIGHT,
) {
  private var count = 0

  /** True and counted when there is room. */
  @Synchronized fun tryAcquire(): Boolean = (count < max).also { if (it) count++ }

  /** Counts a request that already exists, as when a replacement adopts it. */
  @Synchronized
  fun acquire() {
    count++
  }

  @Synchronized
  fun release() {
    if (count > 0) count--
  }
}

/**
 * One decimal, halves away from zero like Swift's `rounded()`, so both platforms report the same
 * point.
 */
private fun roundHalfUp(value: Double): Double =
  (if (value < 0) -floor(-value * 10 + 0.5) else floor(value * 10 + 0.5)) / 10
