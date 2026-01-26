package dev.jasonpearson.automobile.ide.datasource

import dev.jasonpearson.automobile.ide.daemon.AutoMobileClient
import dev.jasonpearson.automobile.ide.daemon.McpConnectionException
import dev.jasonpearson.automobile.ide.layout.ElementBounds
import dev.jasonpearson.automobile.ide.layout.UIElementInfo
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.util.Base64

/**
 * Real layout data source that fetches from MCP resources.
 * Uses the observation/latest resource to get the view hierarchy
 * and observation/latest/screenshot for the screenshot image.
 */
class RealLayoutDataSource(
    private val clientProvider: (() -> AutoMobileClient)? = null,
) : LayoutDataSource {
    private val json = Json { ignoreUnknownKeys = true }

    override suspend fun getViewHierarchy(): Result<UIElementInfo> {
        return when (val result = getObservation()) {
            is Result.Success -> Result.Success(result.data.hierarchy)
            is Result.Error -> Result.Error(result.message)
            is Result.Loading -> Result.Loading
        }
    }

    override suspend fun getObservation(): Result<ObservationData> {
        val provider = clientProvider ?: return Result.Success(
            ObservationData(hierarchy = createEmptyHierarchy())
        )

        return try {
            val client = provider()

            // Fetch observation data (hierarchy + metadata)
            val observationContents = client.readResource("automobile:observation/latest")
            val observationText = observationContents.firstOrNull { !it.text.isNullOrBlank() }?.text

            if (observationText == null) {
                return Result.Success(
                    ObservationData(
                        hierarchy = createEmptyHierarchy("No observation data available.")
                    )
                )
            }

            // Check for error response
            val jsonElement = json.parseToJsonElement(observationText)
            if (jsonElement is kotlinx.serialization.json.JsonObject) {
                val error = jsonElement["error"]?.let {
                    (it as? kotlinx.serialization.json.JsonPrimitive)?.content
                }
                if (!error.isNullOrBlank()) {
                    return Result.Success(
                        ObservationData(
                            hierarchy = createEmptyHierarchy("No observation captured. Call 'observe' to capture screen state.")
                        )
                    )
                }
            }

            // Parse the observation response
            val response = json.decodeFromString(ObservationResponse.serializer(), observationText)

            // Convert to UIElementInfo tree
            val hierarchy = response.viewHierarchy?.elements?.firstOrNull()?.let { parseHierarchy(it, 0) }
                ?: response.hierarchy?.let { parseHierarchy(it, 0) }
                ?: createEmptyHierarchy()

            // Fetch screenshot separately
            val screenshotData = try {
                val screenshotContents = client.readResource("automobile:observation/latest/screenshot")
                val screenshotBlob = screenshotContents.firstOrNull { !it.blob.isNullOrBlank() }?.blob
                screenshotBlob?.let { Base64.getDecoder().decode(it) }
            } catch (e: Exception) {
                // Screenshot fetch failed - continue without it
                null
            }

            Result.Success(
                ObservationData(
                    hierarchy = hierarchy,
                    screenshotData = screenshotData,
                    screenWidth = response.screenSize?.width ?: 1080,
                    screenHeight = response.screenSize?.height ?: 2340,
                    timestamp = response.updatedAt ?: System.currentTimeMillis(),
                )
            )
        } catch (e: McpConnectionException) {
            Result.Error("MCP server not available: ${e.message}")
        } catch (e: Exception) {
            Result.Error("Failed to load observation: ${e.message}")
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
    val updatedAt: Long? = null,
    val screenSize: ScreenSizeDto? = null,
    val viewHierarchy: ViewHierarchyDto? = null,
    // Legacy fallback for simpler hierarchy format
    val hierarchy: HierarchyNodeDto? = null,
)

@Serializable
private data class ScreenSizeDto(
    val width: Int? = null,
    val height: Int? = null,
)

@Serializable
private data class ViewHierarchyDto(
    val elements: List<HierarchyNodeDto>? = null,
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
