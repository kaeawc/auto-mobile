package dev.jasonpearson.automobile.desktop.core.settings

import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File

private val LOG = LoggerFactory.getLogger("WindowStateManager")

/**
 * Persisted layout preset: a named snapshot of pane visibility and sizes.
 */
@Serializable
data class LayoutPreset(
    val name: String,
    val showLeftPane: Boolean = true,
    val showRightPane: Boolean = true,
    val showBottomPane: Boolean = false,
    val leftPaneWidthDp: Float = 220f,
    val rightPaneWidthDp: Float = 300f,
    val bottomPaneHeightDp: Float = 120f,
)

/**
 * All persisted window and layout state, serialized to `~/.automobile/window-state.json`.
 */
@Serializable
data class WindowState(
    // Window geometry
    val windowWidthDp: Float = 1440f,
    val windowHeightDp: Float = 900f,
    val windowXDp: Float? = null,
    val windowYDp: Float? = null,
    // Pane visibility
    val showLeftPane: Boolean = true,
    val showRightPane: Boolean = true,
    val showBottomPane: Boolean = false,
    // Pane sizes (Dp values stored as Float)
    val leftPaneWidthDp: Float = 220f,
    val rightPaneWidthDp: Float = 300f,
    val bottomPaneHeightDp: Float = 120f,
    // Filter preferences
    val telemetryCategoryFilter: String = "All",
    val telemetrySearchQuery: String = "",
    // Layout presets
    val presets: List<LayoutPreset> = emptyList(),
)

private val json = Json {
    prettyPrint = true
    ignoreUnknownKeys = true
    encodeDefaults = true
}

/** Manages persistence of window state to `~/.automobile/window-state.json`. */
interface WindowStateManager {
    fun load(): WindowState
    fun save(state: WindowState)
}

/**
 * File-backed implementation that reads/writes JSON.
 *
 * @param file Override the default path for testing.
 */
class FileWindowStateManager(
    private val file: File = defaultFile(),
) : WindowStateManager {

    override fun load(): WindowState {
        return try {
            if (file.exists()) {
                json.decodeFromString<WindowState>(file.readText())
            } else {
                WindowState()
            }
        } catch (e: Exception) {
            LOG.warn("Failed to read window state from ${file.absolutePath}, using defaults", e)
            WindowState()
        }
    }

    override fun save(state: WindowState) {
        try {
            file.parentFile?.mkdirs()
            file.writeText(json.encodeToString(state))
        } catch (e: Exception) {
            LOG.warn("Failed to write window state to ${file.absolutePath}", e)
        }
    }

    companion object {
        fun defaultFile(): File {
            val home = System.getProperty("user.home") ?: "."
            return File(home, ".automobile/window-state.json")
        }
    }
}

/** In-memory implementation for tests. */
class FakeWindowStateManager(
    private var current: WindowState = WindowState(),
) : WindowStateManager {
    override fun load(): WindowState = current
    override fun save(state: WindowState) { current = state }
}
