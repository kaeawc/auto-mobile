package dev.jasonpearson.automobile.desktop.core.datasource

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException
import dev.jasonpearson.automobile.desktop.core.daemon.encodeResourceUriComponent
import dev.jasonpearson.automobile.desktop.core.navigation.ProvenanceBuildKey
import dev.jasonpearson.automobile.desktop.core.navigation.ScreenNode
import dev.jasonpearson.automobile.desktop.core.navigation.ScreenProvenance
import dev.jasonpearson.automobile.desktop.core.navigation.ScreenTransition
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.serializer

/**
 * Real navigation data source that fetches from MCP resources. Adapts the MCP navigation/graph
 * resource to the IDE's UX model.
 *
 * @param clientProvider Function to provide an AutoMobileClient for MCP access
 * @param appId Optional app ID to filter the navigation graph by specific app
 */
class RealNavigationDataSource(
  private val clientProvider: (() -> AutoMobileClient)? = null,
  private val appId: String? = null,
) : NavigationDataSource {
  private val json = Json { ignoreUnknownKeys = true }

  override suspend fun getNavigationGraph(): Result<NavigationGraph> {
    val provider =
      clientProvider
        ?: return Result.Success(NavigationGraph(screens = emptyList(), transitions = emptyList()))

    return try {
      val client = provider()

      // Build URI with optional appId filter
      val uri =
        if (appId != null) {
          "automobile:navigation/graph?appId=${encodeResourceUriComponent(appId)}"
        } else {
          "automobile:navigation/graph"
        }

      // Read from MCP resource (not tool call)
      val contents = client.readResource(uri)
      val graphText =
        contents.firstOrNull()?.text
          ?: return Result.Success(
            NavigationGraph(screens = emptyList(), transitions = emptyList())
          )

      // Parse the MCP navigation graph response
      val response = json.decodeFromString(serializer<McpNavigationGraphResponse>(), graphText)

      // The daemon signals failure with an `{ "error": ... }` envelope (not a throw). Because
      // decoding uses ignoreUnknownKeys, that envelope would otherwise parse into an all-defaults
      // response and masquerade as a genuinely-empty graph. A present error field means failure; a
      // real empty graph ({ "nodes": [], "edges": [] }) has a null error and stays Success.
      response.error?.let {
        return Result.Error(RuntimeException(it), it)
      }

      // Count outgoing edges per screen for transitionCount
      val outgoingEdgeCounts = response.edges.groupBy { it.from }.mapValues { it.value.size }

      // Adapt MCP nodes to IDE ScreenNode model
      val screens =
        response.nodes.map { node ->
          ScreenNode(
            id = node.id.toString(),
            name = node.screenName,
            type = inferScreenType(node.screenName),
            packageName = response.appId ?: "",
            transitionCount = outgoingEdgeCounts[node.screenName] ?: 0,
            discoveredAt = System.currentTimeMillis(), // Not available from summary
            screenshotUri = node.screenshotPath, // MCP resource URI for screenshot
            provenance = node.provenance.map { it.toScreenProvenance() },
          )
        }

      // Adapt MCP edges to IDE ScreenTransition model
      val transitions =
        response.edges.map { edge ->
          ScreenTransition(
            id = edge.id.toString(),
            fromScreen = edge.from,
            toScreen = edge.to,
            trigger = toolNameToTrigger(edge.toolName),
            element = null, // Would need detailed edge data
            avgLatencyMs = 0, // Not available from MCP yet
            failureRate = 0f, // Not available from MCP yet
            traversalCount = edge.traversalCount,
            provenance = edge.provenance.map { it.toScreenProvenance() },
          )
        }

      Result.Success(NavigationGraph(screens = screens, transitions = transitions))
    } catch (e: McpConnectionException) {
      Result.Error(e, "MCP server not available: ${e.message}")
    } catch (c: CancellationException) {
      // Let coroutine cancellation propagate so this suspend call stays cancellable.
      throw c
    } catch (e: Exception) {
      Result.Error(e, "Failed to load navigation graph: ${e.message}")
    }
  }

  override suspend fun listApps(): Result<List<NavigationAppSummary>> {
    val provider = clientProvider ?: return Result.Success(emptyList())

    return try {
      val client = provider()
      // Device-optional resource: the daemon returns every app with a persisted graph,
      // newest-first.
      val contents = client.readResource("automobile:navigation/apps")
      val text = contents.firstOrNull()?.text ?: return Result.Success(emptyList())

      val response = json.decodeFromString(serializer<McpNavigationAppsResponse>(), text)
      // A present `error` field is the daemon's failure envelope; a genuinely-empty result
      // ({ "apps": [] }) has a null error and stays Success. See getNavigationGraph for why the
      // envelope must be detected explicitly under ignoreUnknownKeys.
      response.error?.let {
        return Result.Error(RuntimeException(it), it)
      }
      val apps =
        response.apps.map { app ->
          NavigationAppSummary(
            appId = app.appId,
            displayName = app.displayName,
            lastUpdated = app.lastUpdated,
          )
        }
      Result.Success(apps)
    } catch (e: McpConnectionException) {
      Result.Error(e, "MCP server not available: ${e.message}")
    } catch (c: CancellationException) {
      throw c
    } catch (e: Exception) {
      Result.Error(e, "Failed to load saved navigation apps: ${e.message}")
    }
  }

  /** Infer screen type from screen name patterns. */
  private fun inferScreenType(screenName: String): String {
    val lowerName = screenName.lowercase()
    return when {
      lowerName.contains("dialog") || lowerName.contains("alert") -> "Dialog"
      lowerName.contains("sheet") || lowerName.contains("bottom") -> "BottomSheet"
      lowerName.contains("fragment") -> "Fragment"
      lowerName.contains("popup") || lowerName.contains("menu") -> "Popup"
      else -> "Activity"
    }
  }

  /** Map MCP tool name to UI trigger type. */
  private fun toolNameToTrigger(toolName: String?): String {
    if (toolName == null) return "unknown"
    val lowerTool = toolName.lowercase()
    return when {
      lowerTool.contains("tap") -> "tap"
      lowerTool.contains("swipe") || lowerTool.contains("scroll") -> "swipe"
      lowerTool.contains("input") || lowerTool.contains("text") -> "input"
      lowerTool.contains("press") || lowerTool.contains("button") -> "press"
      lowerTool.contains("back") -> "back"
      lowerTool.contains("launch") -> "launch"
      else -> toolName
    }
  }
}

// MCP response models - matches exactly what MCP server provides

@Serializable
private data class McpNavigationGraphResponse(
  val appId: String? = null,
  val nodes: List<McpNavigationNode> = emptyList(),
  val edges: List<McpNavigationEdge> = emptyList(),
  val currentScreen: String? = null,
  // Present only on the daemon's `{ "error": ... }` failure envelope; null on a real graph.
  val error: String? = null,
)

@Serializable
private data class McpNavigationNode(
  val id: Int,
  val screenName: String,
  val visitCount: Int,
  val screenshotPath: String? = null, // MCP resource URI for screenshot thumbnail
  // Per-(build, device, session) provenance (#4985). Additive: absent on pre-provenance daemons,
  // defaulting to an empty list, so the node simply renders without fade.
  val provenance: List<McpNavigationProvenance> = emptyList(),
)

@Serializable
private data class McpNavigationEdge(
  val id: Int,
  val from: String,
  val to: String,
  val toolName: String?,
  val traversalCount: Int = 1,
  // Provenance unioned across the edge rows aggregated into this transition (#4985). Additive.
  val provenance: List<McpNavigationProvenance> = emptyList(),
)

// Matches the additive provenance shape on the `automobile:navigation/graph` resource (#4985):
// { "buildKey": { "packageId", "versionCode", "contentHash" }, "deviceId", "sessionUuid",
//   "lastSeen" }.
@Serializable
private data class McpNavigationProvenance(
  val buildKey: McpNavigationBuildKey,
  val deviceId: String,
  val sessionUuid: String,
  val lastSeen: Long,
) {
  fun toScreenProvenance(): ScreenProvenance =
    ScreenProvenance(
      buildKey =
        ProvenanceBuildKey(
          packageId = buildKey.packageId,
          versionCode = buildKey.versionCode,
          contentHash = buildKey.contentHash,
        ),
      deviceId = deviceId,
      sessionUuid = sessionUuid,
      lastSeen = lastSeen,
    )
}

@Serializable
private data class McpNavigationBuildKey(
  val packageId: String,
  val versionCode: Int,
  val contentHash: String,
)

// Matches the device-optional `automobile:navigation/apps` resource (issue #4910 contract):
// { "apps": [ { "appId": "...", "displayName": null, "lastUpdated": "<ISO-8601>" } ] }
// newest-first.

@Serializable
private data class McpNavigationAppsResponse(
  val apps: List<McpNavigationAppSummary> = emptyList(),
  // Present only on the daemon's `{ "error": ... }` failure envelope; null on a real list.
  val error: String? = null,
)

@Serializable
private data class McpNavigationAppSummary(
  val appId: String,
  val displayName: String? = null,
  val lastUpdated: String,
)
