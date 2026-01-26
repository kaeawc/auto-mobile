package dev.jasonpearson.automobile.ide.layout

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement

private val json = Json { ignoreUnknownKeys = true }

private val log = com.intellij.openapi.diagnostic.Logger.getInstance("HierarchyParser")

/**
 * Parse a hierarchy JsonElement (from observation stream) into a UIElementInfo tree.
 */
fun parseHierarchyFromJson(hierarchyJson: JsonElement): UIElementInfo? {
    return try {
        val viewHierarchyResult = json.decodeFromJsonElement(
            ViewHierarchyResultDto.serializer(),
            hierarchyJson
        )
        viewHierarchyResult.hierarchy?.let { hierarchyContainer ->
            val nodes = hierarchyContainer.nodes
            if (nodes.isNotEmpty()) {
                parseHierarchyNode(nodes.first(), 0)
            } else null
        }
    } catch (e: Exception) {
        log.warn("Failed to parse hierarchy JSON: ${e.message}")
        null
    }
}

private fun parseHierarchyNode(node: HierarchyNodeDto, depth: Int, siblingIndex: Int = 0): UIElementInfo {
    // Parse bounds from either string format "[left,top][right,bottom]" or object {left, top, right, bottom}
    val bounds = parseBoundsElement(node.bounds)

    // Generate a stable ID that persists across updates
    // Use bounds + depth + siblingIndex to create unique, stable IDs
    val baseId = node.resourceId
        ?: node.contentDesc?.let { "desc:$it" }
        ?: node.text?.take(20)?.let { "text:$it" }
        ?: "view"
    // Include depth and siblingIndex to ensure uniqueness for nested containers with same bounds
    val id = "$baseId@d${depth}s${siblingIndex}:${bounds.left},${bounds.top}-${bounds.right},${bounds.bottom}"

    return UIElementInfo(
        id = id,
        className = node.className ?: "android.view.View",
        resourceId = node.resourceId,
        text = node.text,
        contentDescription = node.contentDesc,
        bounds = bounds,
        isClickable = node.clickable == "true",
        isEnabled = node.enabled != "false",
        isFocused = node.focused == "true",
        isSelected = node.selected == "true",
        isScrollable = node.scrollable == "true",
        isCheckable = node.checkable == "true",
        isChecked = node.checked == "true",
        depth = depth,
        children = node.children.mapIndexed { index, child -> parseHierarchyNode(child, depth + 1, index) },
    )
}

private fun parseBoundsElement(boundsElement: JsonElement?): ElementBounds {
    if (boundsElement == null) return ElementBounds(0, 0, 0, 0)

    return when (boundsElement) {
        is kotlinx.serialization.json.JsonPrimitive -> {
            // String format "[left,top][right,bottom]"
            val boundsStr = boundsElement.content
            parseBoundsString(boundsStr)
        }
        is JsonObject -> {
            // Object format {left, top, right, bottom}
            try {
                val boundsDto = json.decodeFromJsonElement(BoundsDto.serializer(), boundsElement)
                ElementBounds(
                    left = boundsDto.left,
                    top = boundsDto.top,
                    right = boundsDto.right,
                    bottom = boundsDto.bottom,
                )
            } catch (e: Exception) {
                ElementBounds(0, 0, 0, 0)
            }
        }
        else -> ElementBounds(0, 0, 0, 0)
    }
}

private fun parseBoundsString(boundsStr: String): ElementBounds {
    // Parse format "[left,top][right,bottom]"
    val regex = """\[(\d+),(\d+)\]\[(\d+),(\d+)\]""".toRegex()
    val match = regex.find(boundsStr)
    return if (match != null) {
        val (left, top, right, bottom) = match.destructured
        ElementBounds(
            left = left.toIntOrNull() ?: 0,
            top = top.toIntOrNull() ?: 0,
            right = right.toIntOrNull() ?: 0,
            bottom = bottom.toIntOrNull() ?: 0,
        )
    } else {
        ElementBounds(0, 0, 0, 0)
    }
}

// DTOs for parsing hierarchy JSON

@Serializable
internal data class ViewHierarchyResultDto(
    val hierarchy: HierarchyContainerDto? = null,
    val packageName: String? = null,
)

@Serializable
internal data class HierarchyContainerDto(
    // node can be either a single object or array - use JsonElement for polymorphic parsing
    val node: JsonElement? = null,
) {
    // Parse nodes from the polymorphic node field (can be object or array)
    val nodes: List<HierarchyNodeDto>
        get() {
            val nodeElement = node ?: return emptyList()
            return when (nodeElement) {
                is JsonArray -> {
                    nodeElement.mapNotNull { elem ->
                        try {
                            json.decodeFromJsonElement(HierarchyNodeDto.serializer(), elem)
                        } catch (e: Exception) {
                            null
                        }
                    }
                }
                is JsonObject -> {
                    try {
                        listOf(json.decodeFromJsonElement(HierarchyNodeDto.serializer(), nodeElement))
                    } catch (e: Exception) {
                        emptyList()
                    }
                }
                else -> emptyList()
            }
        }
}

@Serializable
internal data class BoundsDto(
    val left: Int = 0,
    val top: Int = 0,
    val right: Int = 0,
    val bottom: Int = 0,
)

@Serializable
internal data class HierarchyNodeDto(
    val className: String? = null,
    @kotlinx.serialization.SerialName("resource-id")
    val resourceId: String? = null,
    val text: String? = null,
    @kotlinx.serialization.SerialName("content-desc")
    val contentDesc: String? = null,
    // bounds can be either a string "[left,top][right,bottom]" or an object {left, top, right, bottom}
    val bounds: JsonElement? = null,
    val clickable: String? = null,
    val enabled: String? = null,
    val focused: String? = null,
    val focusable: String? = null,
    val selected: String? = null,
    val scrollable: String? = null,
    val checkable: String? = null,
    val checked: String? = null,
    // node can be either a single object or array - use JsonElement
    val node: JsonElement? = null,
) {
    // Parse children from the polymorphic node field
    val children: List<HierarchyNodeDto>
        get() {
            val nodeElement = node ?: return emptyList()
            return when (nodeElement) {
                is JsonArray -> {
                    nodeElement.mapNotNull { elem ->
                        try {
                            json.decodeFromJsonElement(HierarchyNodeDto.serializer(), elem)
                        } catch (e: Exception) {
                            null
                        }
                    }
                }
                is JsonObject -> {
                    try {
                        listOf(json.decodeFromJsonElement(HierarchyNodeDto.serializer(), nodeElement))
                    } catch (e: Exception) {
                        emptyList()
                    }
                }
                else -> emptyList()
            }
        }
}
