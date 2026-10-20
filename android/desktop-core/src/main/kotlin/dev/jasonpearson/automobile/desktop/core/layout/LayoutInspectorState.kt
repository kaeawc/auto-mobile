package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.domain.CoordinateSpace
import dev.jasonpearson.automobile.desktop.domain.HierarchyFrameFacts
import dev.jasonpearson.automobile.desktop.domain.ScreenshotFrameFacts
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * State holder for the Layout Inspector. Manages:
 * - Screenshot data and streaming
 * - View hierarchy
 * - Selection state
 * - Connection status
 * - Changed element tracking for visual feedback
 *
 * Phase 1: Uses mock data Phase 2: Will add WebSocket connection for live data
 *
 * @param debounceContext coroutine context for the hierarchy-update debounce. Defaults to the UI
 *   dispatcher in production; tests inject a `TestDispatcher` to drive the debounce
 *   deterministically with virtual time (no real timers).
 * @param nowMs the client's MONOTONIC clock, stamped onto each applied update so device control can
 *   bound how old the rendered frame is (issue #3348). Monotonic, not wall time: a backwards
 *   wall-clock step (NTP, manual change, VM resume) would make a stalled frame's computed age
 *   negative and leave a frozen mirror controllable. Injected so tests are deterministic without
 *   real timers.
 */
class LayoutInspectorState(
  debounceContext: CoroutineContext = Dispatchers.Main,
  private val nowMs: () -> Long = { System.nanoTime() / 1_000_000L },
) {
  /** Debounce window for rapid hierarchy updates from the stream. */
  companion object {
    const val HIERARCHY_DEBOUNCE_MS = 100L
  }

  // Coroutine scope for debouncing hierarchy updates
  private val debounceScope = CoroutineScope(debounceContext)
  internal var debounceJob: Job? = null

  // Monotonic frame generation (issue #3347). Bumps whenever the rendered frame's device identity
  // is
  // invalidated (device change, observation-stream disconnect, explicit invalidation). Any
  // in-flight
  // screenshot decode or debounced hierarchy job captures the generation it was queued under and is
  // DROPPED if the generation advanced by the time it completes — so a late frame from a superseded
  // context can never restore stale identity/bounds and silently re-enable device control.
  private var generation: Long = 0L

  /**
   * The current frame generation; capture before async frame work and pass it back to the setter.
   */
  val frameGeneration: Long
    get() = generation

  internal fun advanceGeneration() {
    generation++
  }

  // Connection state
  var connectionStatus by mutableStateOf(ConnectionStatus.Disconnected)
    internal set

  var hierarchyUnavailableReason by mutableStateOf<String?>(null)
    internal set

  /** Record an error-shaped hierarchy frame; ordinary malformed frames remain parser warnings. */
  fun recordHierarchyUnavailable(data: JsonElement): Boolean {
    val hierarchy =
      (data as? kotlinx.serialization.json.JsonObject)?.get("hierarchy")
        as? kotlinx.serialization.json.JsonObject
    val error = (hierarchy?.get("error") as? JsonPrimitive)?.contentOrNull ?: return false
    val prefix = "Failed to retrieve iOS view hierarchy from CtrlProxy iOS: "
    if (!error.startsWith(prefix)) return false
    debounceJob?.cancel()
    hierarchyUnavailableReason = error.removePrefix(prefix)
    return true
  }

  var streamingMode by mutableStateOf(StreamingMode.Paused)
    internal set

  // Screenshot state
  var screenshotData by mutableStateOf<ByteArray?>(null)
    internal set

  var screenWidth by mutableStateOf(1080)
    internal set

  var screenHeight by mutableStateOf(2340)
    internal set

  /** Display rotation: 0=portrait, 1=landscape 90deg, 2=reverse portrait, 3=reverse landscape */
  var rotation by mutableStateOf(0)
    internal set

  var lastScreenshotTimestamp by mutableStateOf(0L)
    internal set

  // Device id the currently rendered screenshot came from (issue #3347). Frames are filtered to the
  // active device before they reach [updateScreenshot], so this records which device the on-screen
  // frame belongs to. Device control compares it against the selected device: after a device switch
  // the previous frame lingers until a new one arrives, and a control tap must not actuate the
  // newly
  // selected device against a stale mirror of the previous one. Null until the first live frame.
  var renderedDeviceId by mutableStateOf<String?>(null)
    internal set

  /** Device rotation reported when the currently rendered screenshot was captured. */
  var renderedScreenshotRotation by mutableStateOf<Int?>(null)
    internal set

  // Device id the currently applied hierarchy came from (issue #3347). Distinct from
  // [renderedDeviceId] because clicks are mapped using the hierarchy root bounds, and the hierarchy
  // stream is debounced (~100ms) independently of the screenshot: right after a device switch the
  // new device's screenshot can arrive while the hierarchy is still the previous device's. Device
  // control requires BOTH ids to match the selection so a click is never mapped with one device's
  // dimensions and sent to another. Null until the first hierarchy is applied.
  var renderedHierarchyDeviceId by mutableStateOf<String?>(null)
    internal set

  // Provenance of the applied screenshot / hierarchy (issue #3348). These are the inputs
  // DeviceControlPolicy assembles an atomic DeviceFrameSnapshot from: which update it is
  // (sequence), which device CAPTURE it describes (the daemon's shared captureSequence, paired by
  // equality against the other source's), and how old it is on the CLIENT clock (receivedAtMs is
  // stamped here, by us, never taken from a daemon or device message). Compose state so a
  // composition that evaluates control availability recomposes when a source updates.
  var screenshotFacts by mutableStateOf<ScreenshotFrameFacts?>(null)
    internal set

  var hierarchyFacts by mutableStateOf<HierarchyFrameFacts?>(null)
    internal set

  // Monotonic across every applied source update, so a snapshot built from them can be ordered
  // against an earlier one — which is how the post-input refresh policy recognizes the first
  // snapshot that supersedes the one an input was dispatched through.
  private var sourceSequence: Long = 0L

  private fun nextSourceSequence(): Long {
    sourceSequence++
    return sourceSequence
  }

  // Screenshot capture metadata (from the observation stream's screenshot_update message). Absent
  // (null/false) when the daemon predates this metadata or a field wasn't reported.
  var screenshotFallback by mutableStateOf(false)
    internal set

  var screenshotFallbackReason by mutableStateOf<String?>(null)
    internal set

  var screenshotFormat by mutableStateOf<String?>(null)
    internal set

  var screenshotCaptureSource by mutableStateOf<String?>(null)
    internal set

  // Hierarchy state — stores the full parsed hierarchy with prebuilt indexes
  internal var currentParsedHierarchy by mutableStateOf<ParsedHierarchy?>(null)

  /** The root of the current UI hierarchy tree. */
  val hierarchy: UIElementInfo?
    get() = currentParsedHierarchy?.root

  /** Pre-built element map for O(1) lookups by ID. */
  val currentElementMap: Map<String, UIElementInfo>
    get() = currentParsedHierarchy?.elementMap ?: emptyMap()

  /** Pre-built parent map for O(depth) path lookups. */
  val parentMap: Map<String, String>
    get() = currentParsedHierarchy?.parentMap ?: emptyMap()

  // Changed elements tracking - IDs of elements that changed in the last update
  // Used to trigger flash animations in the tree view
  var changedElementIds by mutableStateOf<Set<String>>(emptySet())
    internal set

  // Selection state
  var selectedElementId by mutableStateOf<String?>(null)
    internal set

  var hoveredElementId by mutableStateOf<String?>(null)
    internal set

  // Tap target compliance highlighting
  var showTapTargetIssues by mutableStateOf(false)
    internal set

  // Cached selected element — O(1) map lookup instead of DFS per recomposition
  var selectedElement by mutableStateOf<UIElementInfo?>(null)
    internal set

  // Initialize with mock data for Phase 1
  init {
    loadMockData()
  }

  /**
   * Update screenshot data. Called when receiving screenshot frames from device. [generation], when
   * provided, is the [frameGeneration] captured before the (async) decode; the update is dropped if
   * the generation has advanced since — a late decode from a superseded context must not restore a
   * stale frame.
   *
   * [coordinateSpace] is the unit the daemon declared [width]/[height] in (issue #4550); it rides
   * into the frame facts so the control policy can pick the exact or the legacy geometry
   * comparison.
   */
  fun updateScreenshot(
    data: ByteArray,
    width: Int,
    height: Int,
    timestamp: Long,
    options: ScreenshotUpdateOptions = ScreenshotUpdateOptions(),
  ) {
    return with(options) {
      if (generation != null && generation != this@LayoutInspectorState.generation) return
      screenshotData = data
      screenWidth = width
      screenHeight = height
      lastScreenshotTimestamp = timestamp
      screenshotFallback = fallback
      screenshotFallbackReason = fallbackReason
      screenshotFormat = format
      screenshotCaptureSource = captureSource
      renderedDeviceId = deviceId
      renderedScreenshotRotation = rotation
      screenshotFacts =
        ScreenshotFrameFacts(
          deviceId = deviceId,
          sequence = nextSourceSequence(),
          captureSequence = captureSequence,
          frameContext = frameContext,
          receivedAtMs = nowMs(),
          width = width,
          height = height,
          // Pair the pixels into the facts, so a snapshot built from them owns the frame it
          // describes and a retained snapshot can render its own bytes (issue #3348).
          data = data,
          coordinateSpace = coordinateSpace,
          nativeScale = nativeScale,
          rotation = rotation,
        )
    }
  }

  /**
   * Update hierarchy data from a raw [UIElementInfo] root (e.g. from initial fetch). Builds indexes
   * internally. For the streaming path, prefer [applyHierarchyUpdate] with a pre-computed
   * [ParsedHierarchy].
   */
  fun updateHierarchy(
    newHierarchy: UIElementInfo,
    newRotation: Int = 0,
    options: HierarchyUpdateOptions = HierarchyUpdateOptions(),
  ) {
    return with(options) {

      // Cancel any queued debounced update so a stale, later-firing job can't overwrite this
      // immediate
      // one (or restore stale hierarchy identity/bounds).
      debounceJob?.cancel()
      val parsed = buildParsedHierarchy(newHierarchy).copy(rotation = newRotation)
      val changedIds = computeChangedElements(currentElementMap, parsed.elementMap)
      applyHierarchyUpdateImmediate(
        parsed = parsed,
        changedIds = changedIds,
        options =
          HierarchyUpdateOptions(
            deviceId = deviceId,
            captureSequence = captureSequence,
            frameContext = frameContext,
            coordinateSpace = coordinateSpace,
            nativeScale = nativeScale,
            captureRotation = captureRotation,
          ),
      )
    }
  }

  /**
   * Apply a pre-computed hierarchy update on the main thread. Only performs fast state assignments
   * — no tree traversals.
   *
   * When multiple updates arrive within [HIERARCHY_DEBOUNCE_MS], only the last one is applied. This
   * prevents excessive recompositions during rapid streaming. Use [applyHierarchyUpdateImmediate]
   * to bypass debouncing.
   */
  fun applyHierarchyUpdate(
    parsed: ParsedHierarchy,
    changedIds: Set<String>,
    generation: Long? = null,
    options: HierarchyUpdateOptions = HierarchyUpdateOptions(),
  ) {
    return with(options) {
      debounceJob?.cancel()
      debounceJob = debounceScope.launch {
        delay(HIERARCHY_DEBOUNCE_MS)
        // Drop a debounced job whose generation was superseded while it waited (device change,
        // invalidation, or disconnect) so it can't restore stale hierarchy identity/bounds.
        if (generation != null && generation != this@LayoutInspectorState.generation) return@launch
        applyHierarchyUpdateImmediate(
          parsed = parsed,
          changedIds = changedIds,
          options =
            HierarchyUpdateOptions(
              deviceId = deviceId,
              captureSequence = captureSequence,
              frameContext = frameContext,
              coordinateSpace = coordinateSpace,
              nativeScale = nativeScale,
              captureRotation = captureRotation,
            ),
        )
      }
    }
  }

  /**
   * Apply a hierarchy update immediately without debouncing. Used for programmatic updates (e.g.
   * initial load, refresh) that should be visible right away. [deviceId] tags the hierarchy with
   * its source device for the device-control gate (issue #3347).
   */
  fun applyHierarchyUpdateImmediate(
    parsed: ParsedHierarchy,
    changedIds: Set<String>,
    options: HierarchyUpdateOptions = HierarchyUpdateOptions(),
  ) {
    return with(options) {
      hierarchyUnavailableReason = null
      changedElementIds = changedIds
      currentParsedHierarchy = parsed
      rotation = parsed.rotation
      renderedHierarchyDeviceId = deviceId
      hierarchyFacts =
        HierarchyFrameFacts(
          deviceId = deviceId,
          sequence = nextSourceSequence(),
          captureSequence = captureSequence,
          frameContext = frameContext,
          receivedAtMs = nowMs(),
          hierarchy = parsed,
          // The root commonly reports (0,0,0,0) on Android (accessibility service); 0 tells the
          // policy to fall back to the observation stream's reported screen size, exactly as the
          // renderer does.
          rootWidth = parsed.root.bounds.width.takeIf { it > 0 } ?: 0,
          rootHeight = parsed.root.bounds.height.takeIf { it > 0 } ?: 0,
          coordinateSpace = coordinateSpace,
          nativeScale = nativeScale,
          rotation = captureRotation,
        )

      // Clear selection if the selected element no longer exists — O(1) map check
      val currentSelectedId = selectedElementId
      if (currentSelectedId != null) {
        if (!parsed.elementMap.containsKey(currentSelectedId)) {
          selectedElementId = null
          selectedElement = null
        } else {
          // Update cached reference in case the element object changed
          selectedElement = parsed.elementMap[currentSelectedId]
        }
      }
    }
  }

  /**
   * Invalidate the rendered frame's device identity (issue #3347) without discarding the frame.
   * Call when the observation stream disconnects but the input socket may still be usable: the
   * on-screen mirror is now frozen/stale, so device control must deactivate (its gate requires both
   * ids to match the selection) even though the frame stays visible for inspection. Unlike
   * [disconnect] this keeps the screenshot and hierarchy so the user can still inspect the last
   * frame.
   *
   * Cancels any pending debounced hierarchy update and advances the frame generation, so a late
   * decode or debounced job queued before the invalidation cannot restore the identity we just
   * cleared.
   */
  fun invalidateRenderedDeviceIdentity() {
    debounceJob?.cancel()
    advanceGeneration()
    hierarchyUnavailableReason = null
    renderedDeviceId = null
    renderedScreenshotRotation = null
    renderedHierarchyDeviceId = null
    // Drop the provenance too: with no facts there is no snapshot, so device control fails closed
    // to inspector mode (issue #3348) while the frame itself stays visible for inspection.
    screenshotFacts = null
    hierarchyFacts = null
  }

  // ========================================
  // Phase 2: WebSocket methods (stubs for now)
  // ========================================

}

/**
 * Build a [ParsedHierarchy] from a raw [UIElementInfo] tree. Traverses the tree once to build
 * element and parent maps.
 */
fun buildParsedHierarchy(root: UIElementInfo): ParsedHierarchy {
  val elementMap = mutableMapOf<String, UIElementInfo>()
  val parentMap = mutableMapOf<String, String>()
  fun traverse(element: UIElementInfo) {
    elementMap[element.id] = element
    for (child in element.children) {
      parentMap[child.id] = element.id
      traverse(child)
    }
  }
  traverse(root)
  return ParsedHierarchy(root = root, elementMap = elementMap, parentMap = parentMap)
}

/** Remember a LayoutInspectorState instance scoped to composition. */
@Composable
fun rememberLayoutInspectorState(): LayoutInspectorState {
  return remember { LayoutInspectorState() }
}

data class ScreenshotUpdateOptions(
  val fallback: Boolean = false,
  val fallbackReason: String? = null,
  val format: String? = null,
  val captureSource: String? = null,
  val deviceId: String? = null,
  val generation: Long? = null,
  val captureSequence: Long? = null,
  val frameContext: String? = null,
  val coordinateSpace: CoordinateSpace? = null,
  val nativeScale: Double? = null,
  val rotation: Int? = null,
)

data class HierarchyUpdateOptions(
  val deviceId: String? = null,
  val captureSequence: Long? = null,
  val frameContext: String? = null,
  val coordinateSpace: CoordinateSpace? = null,
  val nativeScale: Double? = null,
  val captureRotation: Int? = null,
)
