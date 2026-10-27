package dev.jasonpearson.automobile.desktop.core.datasource

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException
import dev.jasonpearson.automobile.desktop.core.layout.ElementBounds
import dev.jasonpearson.automobile.desktop.core.layout.UIElementInfo
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import java.io.IOException
import java.util.Base64
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.serializer

private val LOG = LoggerFactory.getLogger("RealLayoutDataSource")

/**
 * Real layout data source that fetches from MCP. Calls the 'observe' tool to capture fresh screen
 * state, then reads the screenshot from the observation/latest/screenshot resource.
 */
class RealLayoutDataSource(
  private val clientProvider: (() -> AutoMobileClient)? = null,
  private val platform: String = "android",
) : LayoutDataSource {
  private val json = Json { ignoreUnknownKeys = true }

  override suspend fun getViewHierarchy(): Result<UIElementInfo> {
    return when (val result = getObservation()) {
      is Result.Success -> Result.Success(result.data.hierarchy)
      is Result.Error -> result
      is Result.Loading -> Result.Loading
    }
  }

  override suspend fun getObservation(): Result<ObservationData> {
    val provider =
      clientProvider ?: return Result.Success(ObservationData(hierarchy = createEmptyHierarchy()))

    return try {
      val client = provider()

      // Call the observe tool to capture fresh screen state
      val observeResult = client.observe(platform = platform)

      val hierarchy = readHierarchy(observeResult.viewHierarchy)
      val screenshotData = readScreenshot(client)

      Result.Success(
        ObservationData(
          hierarchy = hierarchy,
          screenshotData = screenshotData,
          screenWidth = observeResult.screenSize?.width ?: 1080,
          screenHeight = observeResult.screenSize?.height ?: 2340,
          timestamp = observeResult.updatedAt ?: System.currentTimeMillis(),
          rotation = observeResult.rotation ?: 0,
        ),
      )
    } catch (e: CancellationException) {
      throw e
    } catch (e: McpConnectionException) {
      Result.Error(e, "MCP server not available: ${e.message}")
    } catch (e: IOException) {
      Result.Error(e, "Failed to load observation: ${e.message}")
    } catch (e: IllegalArgumentException) {
      Result.Error(e, "Failed to load observation: ${e.message}")
    } catch (e: IllegalStateException) {
      Result.Error(e, "Failed to load observation: ${e.message}")
    }
  }

  private fun readHierarchy(viewHierarchy: JsonElement?): UIElementInfo {
    if (viewHierarchy == null) return createEmptyHierarchy()
    return try {
      val result = json.decodeFromJsonElement(serializer<ViewHierarchyResultDto>(), viewHierarchy)
      val root = result.hierarchy?.node?.firstOrNull()
      if (root == null) createEmptyHierarchy() else parseHierarchy(root, 0, intArrayOf(0))
    } catch (e: IllegalArgumentException) {
      LOG.warn("Malformed observation hierarchy; using an empty hierarchy", e)
      createEmptyHierarchy()
    }
  }

  private fun readScreenshot(client: AutoMobileClient): ByteArray? {
    return try {
      val contents = client.readResource("automobile:observation/latest/screenshot")
      val blob = contents.firstOrNull { !it.blob.isNullOrBlank() }?.blob
      blob?.let { Base64.getDecoder().decode(it) }
    } catch (e: McpConnectionException) {
      LOG.warn("Could not fetch observation screenshot", e)
      null
    } catch (e: IOException) {
      LOG.warn("Could not fetch observation screenshot", e)
      null
    } catch (e: IllegalArgumentException) {
      LOG.warn("Could not decode observation screenshot", e)
      null
    }
  }

  private fun parseHierarchy(node: HierarchyNodeDto, depth: Int, counter: IntArray): UIElementInfo {
    val bounds = parseBounds(node.bounds)

    // Generate a unique ID using counter to ensure uniqueness across tree
    val nodeIndex = counter[0]++
    val baseId =
      node.resourceId
        ?: node.contentDesc?.let { "desc:$it" }
        ?: node.text?.let { "text:$it" }
        ?: "node-$depth-${bounds.hashCode()}"
    val id = "$baseId#$nodeIndex"

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
      children = node.children.map { parseHierarchy(it, depth + 1, counter) },
    )
  }

  private fun parseBounds(boundsElement: JsonElement?): ElementBounds {
    return when (boundsElement) {
      is JsonObject -> parseObjectBounds(boundsElement)
      is JsonPrimitive ->
        boundsElement.contentOrNull?.let { parseBoundsString(it) } ?: ElementBounds(0, 0, 0, 0)
      // Compact form emitted by the MCP server's --observe-result-compact flag:
      // bounds is the positional tuple [left, top, right, bottom].
      is JsonArray -> parseArrayBounds(boundsElement)
      else -> ElementBounds(0, 0, 0, 0)
    }
  }

  private fun parseObjectBounds(bounds: JsonObject): ElementBounds =
    ElementBounds(
      left = (bounds["left"] as? JsonPrimitive)?.intOrNull ?: 0,
      top = (bounds["top"] as? JsonPrimitive)?.intOrNull ?: 0,
      right = (bounds["right"] as? JsonPrimitive)?.intOrNull ?: 0,
      bottom = (bounds["bottom"] as? JsonPrimitive)?.intOrNull ?: 0,
    )

  private fun parseArrayBounds(bounds: JsonArray): ElementBounds =
    if (bounds.size == 4)
      ElementBounds(
        left = (bounds[0] as? JsonPrimitive)?.intOrNull ?: 0,
        top = (bounds[1] as? JsonPrimitive)?.intOrNull ?: 0,
        right = (bounds[2] as? JsonPrimitive)?.intOrNull ?: 0,
        bottom = (bounds[3] as? JsonPrimitive)?.intOrNull ?: 0,
      )
    else ElementBounds(0, 0, 0, 0)

  private fun parseBoundsString(boundsStr: String): ElementBounds {
    val regex = """\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]""".toRegex()
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
  val viewHierarchy: ViewHierarchyResultDto? = null,
)

@Serializable
private data class ScreenSizeDto(
  val width: Int? = null,
  val height: Int? = null,
)

@Serializable
private data class ViewHierarchyResultDto(
  val hierarchy: HierarchyContainerDto? = null,
  val packageName: String? = null,
)

@Serializable private data class HierarchyContainerDto(val node: List<HierarchyNodeDto>? = null)

@Serializable
private data class HierarchyNodeDto(
  val className: String? = null,
  @kotlinx.serialization.SerialName("resource-id") val resourceId: String? = null,
  val text: String? = null,
  @kotlinx.serialization.SerialName("content-desc") val contentDesc: String? = null,
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
      return when {
        nodeElement is kotlinx.serialization.json.JsonArray -> {
          nodeElement.mapNotNull { elem ->
            try {
              Json { ignoreUnknownKeys = true }
                .decodeFromJsonElement(serializer<HierarchyNodeDto>(), elem)
            } catch (e: IllegalArgumentException) {
              LOG.warn("Could not decode hierarchy child", e)
              null
            }
          }
        }
        nodeElement is kotlinx.serialization.json.JsonObject -> {
          try {
            listOf(
              Json { ignoreUnknownKeys = true }
                .decodeFromJsonElement(serializer<HierarchyNodeDto>(), nodeElement),
            )
          } catch (e: IllegalArgumentException) {
            LOG.warn("Could not decode hierarchy children", e)
            emptyList()
          }
        }
        else -> emptyList()
      }
    }
}
