package dev.jasonpearson.automobile.ide.datasource

import dev.jasonpearson.automobile.ide.daemon.AutoMobileClient
import dev.jasonpearson.automobile.ide.daemon.McpConnectionException
import dev.jasonpearson.automobile.ide.layout.ElementBounds
import dev.jasonpearson.automobile.ide.layout.UIElementInfo
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Real layout data source that fetches from MCP resources.
 * Uses the observation/latest resource to get the view hierarchy.
 */
class RealLayoutDataSource(
    private val clientProvider: (() -> AutoMobileClient)? = null,
) : LayoutDataSource {
    private val json = Json { ignoreUnknownKeys = true }

    override suspend fun getViewHierarchy(): Result<UIElementInfo> {
        val provider = clientProvider ?: return Result.Success(createEmptyHierarchy())

        return try {
            val client = provider()
            val contents = client.readResource("automobile:observation/latest")

            val text = contents.firstOrNull { !it.text.isNullOrBlank() }?.text
                ?: return Result.Success(createEmptyHierarchy())

            // Check for error response
            val jsonElement = json.parseToJsonElement(text)
            if (jsonElement is kotlinx.serialization.json.JsonObject) {
                val error = jsonElement["error"]?.let {
                    (it as? kotlinx.serialization.json.JsonPrimitive)?.content
                }
                if (!error.isNullOrBlank()) {
                    // No observation available yet - return empty hierarchy
                    return Result.Success(createEmptyHierarchy("No observation captured. Call 'observe' to capture screen state."))
                }
            }

            // Parse the observation response
            val response = json.decodeFromString(ObservationResponse.serializer(), text)

            // Convert to UIElementInfo tree
            val hierarchy = response.hierarchy?.let { parseHierarchy(it, 0) }
                ?: createEmptyHierarchy()

            Result.Success(hierarchy)
        } catch (e: McpConnectionException) {
            Result.Error("MCP server not available: ${e.message}")
        } catch (e: Exception) {
            Result.Error("Failed to load view hierarchy: ${e.message}")
        }
    }

    private fun parseHierarchy(node: HierarchyNodeDto, depth: Int): UIElementInfo {
        return UIElementInfo(
            id = node.id ?: "node-$depth-${node.className?.hashCode() ?: 0}",
            className = node.className ?: "android.view.View",
            resourceId = node.resourceId,
            text = node.text,
            contentDescription = node.contentDescription,
            bounds = node.bounds?.let {
                ElementBounds(
                    left = it.left ?: 0,
                    top = it.top ?: 0,
                    right = it.right ?: 0,
                    bottom = it.bottom ?: 0,
                )
            } ?: ElementBounds(0, 0, 0, 0),
            isClickable = node.clickable ?: false,
            isEnabled = node.enabled ?: true,
            isFocused = node.focused ?: false,
            isSelected = node.selected ?: false,
            isScrollable = node.scrollable ?: false,
            isCheckable = node.checkable ?: false,
            isChecked = node.checked ?: false,
            depth = depth,
            children = node.children?.map { parseHierarchy(it, depth + 1) } ?: emptyList(),
        )
    }

    private fun createEmptyHierarchy(message: String? = null): UIElementInfo {
        return UIElementInfo(
            id = "root_placeholder",
            className = "android.view.View",
            resourceId = null,
            text = message ?: "No data available",
            contentDescription = null,
            bounds = ElementBounds(0, 0, 0, 0),
            isClickable = false,
            isEnabled = false,
            isFocused = false,
            isSelected = false,
            isScrollable = false,
            isCheckable = false,
            isChecked = false,
            depth = 0,
            children = emptyList(),
        )
    }
}

// MCP response models for observation

@Serializable
private data class ObservationResponse(
    val hierarchy: HierarchyNodeDto? = null,
    val screenshot: String? = null,
    val screenWidth: Int? = null,
    val screenHeight: Int? = null,
    val timestamp: Long? = null,
)

@Serializable
private data class HierarchyNodeDto(
    val id: String? = null,
    val className: String? = null,
    val resourceId: String? = null,
    val text: String? = null,
    val contentDescription: String? = null,
    val bounds: BoundsDto? = null,
    val clickable: Boolean? = null,
    val enabled: Boolean? = null,
    val focused: Boolean? = null,
    val selected: Boolean? = null,
    val scrollable: Boolean? = null,
    val checkable: Boolean? = null,
    val checked: Boolean? = null,
    val children: List<HierarchyNodeDto>? = null,
)

@Serializable
private data class BoundsDto(
    val left: Int? = null,
    val top: Int? = null,
    val right: Int? = null,
    val bottom: Int? = null,
)
