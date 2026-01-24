package dev.jasonpearson.automobile.ide.layout

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue

/**
 * State holder for the Layout Inspector.
 * Manages:
 * - Screenshot data and streaming
 * - View hierarchy
 * - Selection state
 * - Connection status
 *
 * Phase 1: Uses mock data
 * Phase 2: Will add WebSocket connection for live data
 */
class LayoutInspectorState {
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

    var lastScreenshotTimestamp by mutableStateOf(0L)
        private set

    // Hierarchy state
    var hierarchy by mutableStateOf<UIElementInfo?>(null)
        private set

    // Selection state
    var selectedElementId by mutableStateOf<String?>(null)
        private set

    var hoveredElementId by mutableStateOf<String?>(null)
        private set

    // Selected element (computed from hierarchy and selectedElementId)
    val selectedElement: UIElementInfo?
        get() = hierarchy?.let { root ->
            selectedElementId?.let { id ->
                LayoutInspectorMockData.findElementById(root, id)
            }
        }

    // Initialize with mock data for Phase 1
    init {
        loadMockData()
    }

    /**
     * Load mock data for development/testing.
     */
    fun loadMockData() {
        hierarchy = LayoutInspectorMockData.mockHierarchy
        connectionStatus = ConnectionStatus.Connected
        streamingMode = StreamingMode.Paused
    }

    /**
     * Set the selected element by ID.
     */
    fun selectElement(elementId: String?) {
        selectedElementId = elementId
    }

    /**
     * Set the hovered element by ID.
     */
    fun hoverElement(elementId: String?) {
        hoveredElementId = elementId
    }

    /**
     * Clear selection.
     */
    fun clearSelection() {
        selectedElementId = null
    }

    /**
     * Toggle streaming mode (live/paused).
     */
    fun toggleStreaming() {
        streamingMode = when (streamingMode) {
            StreamingMode.Live -> StreamingMode.Paused
            StreamingMode.Paused -> StreamingMode.Live
        }
    }

    /**
     * Update streaming mode.
     */
    fun updateStreamingMode(mode: StreamingMode) {
        streamingMode = mode
    }

    /**
     * Refresh the hierarchy from the device.
     * Phase 1: Reloads mock data
     * Phase 2: Will request fresh data via WebSocket
     */
    fun refreshHierarchy() {
        // Phase 1: Just reload mock data
        hierarchy = LayoutInspectorMockData.mockHierarchy
        lastScreenshotTimestamp = System.currentTimeMillis()
    }

    /**
     * Update screenshot data.
     * Called when receiving screenshot frames from device.
     */
    fun updateScreenshot(data: ByteArray, width: Int, height: Int, timestamp: Long) {
        screenshotData = data
        screenWidth = width
        screenHeight = height
        lastScreenshotTimestamp = timestamp
    }

    /**
     * Update hierarchy data.
     * Called when receiving hierarchy updates from device.
     */
    fun updateHierarchy(newHierarchy: UIElementInfo) {
        hierarchy = newHierarchy
    }

    /**
     * Connect to device.
     * Phase 1: Simulates connection
     * Phase 2: Will establish WebSocket connection
     */
    fun connect() {
        connectionStatus = ConnectionStatus.Connecting
        // Simulate connection delay then connect
        connectionStatus = ConnectionStatus.Connected
        loadMockData()
    }

    /**
     * Disconnect from device.
     */
    fun disconnect() {
        connectionStatus = ConnectionStatus.Disconnected
        streamingMode = StreamingMode.Paused
        screenshotData = null
    }

    // ========================================
    // Phase 2: WebSocket methods (stubs for now)
    // ========================================

    /**
     * Start screenshot streaming.
     * Phase 2: Will send subscribe_screenshots message via WebSocket.
     */
    fun startScreenshotStream(intervalMs: Int = 100, quality: Int = 70) {
        streamingMode = StreamingMode.Live
        // Phase 2: Send WebSocket message
        // { "type": "subscribe_screenshots", "intervalMs": intervalMs, "quality": quality }
    }

    /**
     * Stop screenshot streaming.
     * Phase 2: Will send unsubscribe_screenshots message via WebSocket.
     */
    fun stopScreenshotStream() {
        streamingMode = StreamingMode.Paused
        // Phase 2: Send WebSocket message
        // { "type": "unsubscribe_screenshots" }
    }
}

/**
 * Remember a LayoutInspectorState instance scoped to composition.
 */
@Composable
fun rememberLayoutInspectorState(): LayoutInspectorState {
    return remember { LayoutInspectorState() }
}
