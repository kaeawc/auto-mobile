package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.domain.HierarchyFrameFacts
import dev.jasonpearson.automobile.desktop.domain.ScreenshotFrameFacts
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

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
 * @param nowMs client wall clock, stamped onto each applied update so device control can bound how
 *   old the rendered frame is (issue #3348). Injected so tests are deterministic without real
 *   timers.
 */
class LayoutInspectorState(
  debounceContext: CoroutineContext = Dispatchers.Main,
  private val nowMs: () -> Long = { System.currentTimeMillis() },
) {
  /** Debounce window for rapid hierarchy updates from the stream. */
  companion object {
    const val HIERARCHY_DEBOUNCE_MS = 100L
  }

  // Coroutine scope for debouncing hierarchy updates
  private val debounceScope = CoroutineScope(debounceContext)
  private var debounceJob: Job? = null

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

  private fun advanceGeneration() {
    generation++
  }

  // Connection state
  var connectionStatus by mutableStateOf(ConnectionStatus.Disconnected)
    private set

  var streamingMode by mutableStateOf(StreamingMode.Paused)
    private set

  // Screenshot state
  var screenshotData by mutableStateOf<ByteArray?>(null)
    private set

  var screenWidth by mutableStateOf(1080)
    private set

  var screenHeight by mutableStateOf(2340)
    private set

  /** Display rotation: 0=portrait, 1=landscape 90deg, 2=reverse portrait, 3=reverse landscape */
  var rotation by mutableStateOf(0)
    private set

  var lastScreenshotTimestamp by mutableStateOf(0L)
    private set

  // Device id the currently rendered screenshot came from (issue #3347). Frames are filtered to the
  // active device before they reach [updateScreenshot], so this records which device the on-screen
  // frame belongs to. Device control compares it against the selected device: after a device switch
  // the previous frame lingers until a new one arrives, and a control tap must not actuate the
  // newly
  // selected device against a stale mirror of the previous one. Null until the first live frame.
  var renderedDeviceId by mutableStateOf<String?>(null)
    private set

  // Device id the currently applied hierarchy came from (issue #3347). Distinct from
  // [renderedDeviceId] because clicks are mapped using the hierarchy root bounds, and the hierarchy
  // stream is debounced (~100ms) independently of the screenshot: right after a device switch the
  // new device's screenshot can arrive while the hierarchy is still the previous device's. Device
  // control requires BOTH ids to match the selection so a click is never mapped with one device's
  // dimensions and sent to another. Null until the first hierarchy is applied.
  var renderedHierarchyDeviceId by mutableStateOf<String?>(null)
    private set

  // Provenance of the applied screenshot / hierarchy (issue #3348). These are the inputs
  // DeviceControlPolicy assembles an atomic DeviceFrameSnapshot from: which update it is
  // (sequence), which device state it describes (the daemon's capture timestamp, comparable only
  // against the other source's daemon timestamp), and how old it is on the client clock. Compose
  // state so a composition that evaluates control availability recomposes when a source updates.
  var screenshotFacts by mutableStateOf<ScreenshotFrameFacts?>(null)
    private set

  var hierarchyFacts by mutableStateOf<HierarchyFrameFacts?>(null)
    private set

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
    private set

  var screenshotFallbackReason by mutableStateOf<String?>(null)
    private set

  var screenshotFormat by mutableStateOf<String?>(null)
    private set

  var screenshotCaptureSource by mutableStateOf<String?>(null)
    private set

  // Hierarchy state — stores the full parsed hierarchy with prebuilt indexes
  private var currentParsedHierarchy by mutableStateOf<ParsedHierarchy?>(null)

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
    private set

  // Selection state
  var selectedElementId by mutableStateOf<String?>(null)
    private set

  var hoveredElementId by mutableStateOf<String?>(null)
    private set

  // Tap target compliance highlighting
  var showTapTargetIssues by mutableStateOf(false)
    private set

  // Cached selected element — O(1) map lookup instead of DFS per recomposition
  var selectedElement by mutableStateOf<UIElementInfo?>(null)
    private set

  // Initialize with mock data for Phase 1
  init {
    loadMockData()
  }

  /** Load mock data for development/testing. */
  fun loadMockData() {
    val root = LayoutInspectorMockData.mockHierarchy
    currentParsedHierarchy = buildParsedHierarchy(root)
    connectionStatus = ConnectionStatus.Connected
    streamingMode = StreamingMode.Paused
  }

  /** Set the selected element by ID. */
  fun selectElement(elementId: String?) {
    selectedElementId = elementId
    selectedElement = elementId?.let { currentElementMap[it] }
  }

  /** Set the hovered element by ID. */
  fun hoverElement(elementId: String?) {
    hoveredElementId = elementId
  }

  /** Toggle tap target compliance highlighting. */
  fun toggleTapTargetIssues() {
    showTapTargetIssues = !showTapTargetIssues
  }

  /** Clear selection. */
  fun clearSelection() {
    selectedElementId = null
    selectedElement = null
  }

  /** Toggle streaming mode (live/paused). */
  fun toggleStreaming() {
    streamingMode =
      when (streamingMode) {
        StreamingMode.Live -> StreamingMode.Paused
        StreamingMode.Paused -> StreamingMode.Live
      }
  }

  /** Update streaming mode. */
  fun updateStreamingMode(mode: StreamingMode) {
    streamingMode = mode
  }

  /**
   * Refresh the hierarchy from the device. Phase 1: Reloads mock data Phase 2: Will request fresh
   * data via WebSocket
   */
  fun refreshHierarchy() {
    // Phase 1: Just reload mock data
    val root = LayoutInspectorMockData.mockHierarchy
    currentParsedHierarchy = buildParsedHierarchy(root)
    lastScreenshotTimestamp = System.currentTimeMillis()
  }

  /**
   * Update screenshot data. Called when receiving screenshot frames from device. [generation], when
   * provided, is the [frameGeneration] captured before the (async) decode; the update is dropped if
   * the generation has advanced since — a late decode from a superseded context must not restore a
   * stale frame.
   */
  fun updateScreenshot(
    data: ByteArray,
    width: Int,
    height: Int,
    timestamp: Long,
    fallback: Boolean = false,
    fallbackReason: String? = null,
    format: String? = null,
    captureSource: String? = null,
    deviceId: String? = null,
    generation: Long? = null,
  ) {
    if (generation != null && generation != this.generation) return
    screenshotData = data
    screenWidth = width
    screenHeight = height
    lastScreenshotTimestamp = timestamp
    screenshotFallback = fallback
    screenshotFallbackReason = fallbackReason
    screenshotFormat = format
    screenshotCaptureSource = captureSource
    renderedDeviceId = deviceId
    screenshotFacts =
      ScreenshotFrameFacts(
        deviceId = deviceId,
        sequence = nextSourceSequence(),
        daemonTimestampMs = timestamp,
        receivedAtMs = nowMs(),
        width = width,
        height = height,
      )
  }

  /**
   * Update hierarchy data from a raw [UIElementInfo] root (e.g. from initial fetch). Builds indexes
   * internally. For the streaming path, prefer [applyHierarchyUpdate] with a pre-computed
   * [ParsedHierarchy].
   */
  fun updateHierarchy(
    newHierarchy: UIElementInfo,
    newRotation: Int = 0,
    deviceId: String? = null,
    daemonTimestampMs: Long = 0L,
  ) {
    // Cancel any queued debounced update so a stale, later-firing job can't overwrite this
    // immediate
    // one (or restore stale hierarchy identity/bounds).
    debounceJob?.cancel()
    val parsed = buildParsedHierarchy(newHierarchy).copy(rotation = newRotation)
    val changedIds = computeChangedElements(currentElementMap, parsed.elementMap)
    applyHierarchyUpdateImmediate(parsed, changedIds, deviceId, daemonTimestampMs)
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
    deviceId: String? = null,
    generation: Long? = null,
    daemonTimestampMs: Long = 0L,
  ) {
    debounceJob?.cancel()
    debounceJob = debounceScope.launch {
      delay(HIERARCHY_DEBOUNCE_MS)
      // Drop a debounced job whose generation was superseded while it waited (device change,
      // invalidation, or disconnect) so it can't restore stale hierarchy identity/bounds.
      if (generation != null && generation != this@LayoutInspectorState.generation) return@launch
      applyHierarchyUpdateImmediate(parsed, changedIds, deviceId, daemonTimestampMs)
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
    deviceId: String? = null,
    daemonTimestampMs: Long = 0L,
  ) {
    changedElementIds = changedIds
    currentParsedHierarchy = parsed
    rotation = parsed.rotation
    renderedHierarchyDeviceId = deviceId
    hierarchyFacts =
      HierarchyFrameFacts(
        deviceId = deviceId,
        sequence = nextSourceSequence(),
        daemonTimestampMs = daemonTimestampMs,
        receivedAtMs = nowMs(),
        hierarchy = parsed,
        // The root commonly reports (0,0,0,0) on Android (accessibility service); 0 tells the
        // policy to fall back to the observation stream's reported screen size, exactly as the
        // renderer does.
        rootWidth = parsed.root.bounds.width.takeIf { it > 0 } ?: 0,
        rootHeight = parsed.root.bounds.height.takeIf { it > 0 } ?: 0,
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

  /** Clear the changed elements set. Called after flash animation completes. */
  fun clearChangedElements() {
    changedElementIds = emptySet()
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
    renderedDeviceId = null
    renderedHierarchyDeviceId = null
    // Drop the provenance too: with no facts there is no snapshot, so device control fails closed
    // to inspector mode (issue #3348) while the frame itself stays visible for inspection.
    screenshotFacts = null
    hierarchyFacts = null
  }

  /**
   * Compare two element maps to find IDs that are new or have changed properties. Pure function —
   * safe to call off the main thread.
   */
  fun computeChangedElements(
    oldElementMap: Map<String, UIElementInfo>,
    newElementMap: Map<String, UIElementInfo>,
  ): Set<String> {
    if (oldElementMap.isEmpty()) return emptySet()
    val changedIds = mutableSetOf<String>()
    for ((id, newElement) in newElementMap) {
      val oldElement = oldElementMap[id]
      if (oldElement == null) {
        changedIds.add(id)
      } else if (hasElementChanged(oldElement, newElement)) {
        changedIds.add(id)
      }
    }
    return changedIds
  }

  /** Check if an element's visible properties have changed. */
  private fun hasElementChanged(old: UIElementInfo, new: UIElementInfo): Boolean {
    return old.text != new.text ||
      old.contentDescription != new.contentDescription ||
      old.bounds != new.bounds ||
      old.isClickable != new.isClickable ||
      old.isEnabled != new.isEnabled ||
      old.isFocused != new.isFocused ||
      old.isSelected != new.isSelected ||
      old.isScrollable != new.isScrollable ||
      old.isCheckable != new.isCheckable ||
      old.isChecked != new.isChecked ||
      old.children.size != new.children.size
  }

  /**
   * Connect to device. Phase 1: Simulates connection Phase 2: Will establish WebSocket connection
   */
  fun connect() {
    connectionStatus = ConnectionStatus.Connecting
    // Simulate connection delay then connect
    connectionStatus = ConnectionStatus.Connected
    loadMockData()
  }

  /** Update connection status externally (e.g., from stream connection state). */
  fun updateConnectionStatus(status: ConnectionStatus) {
    connectionStatus = status
  }

  /** Disconnect from device. Clears all device-specific stale data. */
  fun disconnect() {
    debounceJob?.cancel()
    // Advance the generation so any in-flight decode/debounced job from before the disconnect is
    // dropped instead of repopulating stale state.
    advanceGeneration()
    connectionStatus = ConnectionStatus.Disconnected
    streamingMode = StreamingMode.Paused
    screenshotData = null
    screenshotFallback = false
    screenshotFallbackReason = null
    screenshotFormat = null
    screenshotCaptureSource = null
    renderedDeviceId = null
    renderedHierarchyDeviceId = null
    screenshotFacts = null
    hierarchyFacts = null
    currentParsedHierarchy = null
    rotation = 0
    selectedElementId = null
    selectedElement = null
    hoveredElementId = null
    changedElementIds = emptySet()
  }

  // ========================================
  // Phase 2: WebSocket methods (stubs for now)
  // ========================================

  /** Start screenshot streaming. Phase 2: Will send subscribe_screenshots message via WebSocket. */
  fun startScreenshotStream(intervalMs: Int = 100, quality: Int = 70) {
    streamingMode = StreamingMode.Live
    // Phase 2: Send WebSocket message
    // { "type": "subscribe_screenshots", "intervalMs": intervalMs, "quality": quality }
  }

  /**
   * Stop screenshot streaming. Phase 2: Will send unsubscribe_screenshots message via WebSocket.
   */
  fun stopScreenshotStream() {
    streamingMode = StreamingMode.Paused
    // Phase 2: Send WebSocket message
    // { "type": "unsubscribe_screenshots" }
  }
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
