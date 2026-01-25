package dev.jasonpearson.automobile.ide.datasource

import dev.jasonpearson.automobile.ide.daemon.AutoMobileClient
import dev.jasonpearson.automobile.ide.daemon.McpConnectionException
import dev.jasonpearson.automobile.ide.navigation.ScreenNode
import dev.jasonpearson.automobile.ide.navigation.ScreenTransition
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.decodeFromJsonElement

/**
 * Real navigation data source that fetches from MCP resources.
 * Uses the navigation/graph resource to get the actual navigation graph.
 */
class RealNavigationDataSource(
    private val clientProvider: (() -> AutoMobileClient)? = null,
) : NavigationDataSource {
    private val json = Json { ignoreUnknownKeys = true }

    override suspend fun getNavigationGraph(): Result<NavigationGraph> {
        val provider = clientProvider ?: return Result.Success(
            NavigationGraph(screens = emptyList(), transitions = emptyList())
        )

        return try {
            val client = provider()
            val graphElement = client.getNavigationGraph("android")

            // Parse the navigation graph response
            val response = json.decodeFromJsonElement(NavigationGraphResponse.serializer(), graphElement)

            // Map to UI models
            val screens = response.nodes.mapIndexed { index, node ->
                ScreenNode(
                    id = node.id ?: "screen-$index",
                    name = node.name ?: node.id ?: "Unknown",
                    type = node.type ?: "Unknown",
                    packageName = node.packageName ?: "",
                    testCoverage = node.testCoverage ?: 0,
                    transitionCount = node.transitionCount ?: 0,
                    discoveredAt = node.discoveredAt ?: System.currentTimeMillis(),
                )
            }

            val transitions = response.edges.mapIndexed { index, edge ->
                ScreenTransition(
                    id = edge.id ?: "transition-$index",
                    fromScreen = edge.from ?: "",
                    toScreen = edge.to ?: "",
                    trigger = edge.trigger ?: "tap",
                    element = edge.element,
                    avgLatencyMs = edge.avgLatencyMs ?: 0,
                    failureRate = edge.failureRate ?: 0f,
                )
            }

            Result.Success(NavigationGraph(screens = screens, transitions = transitions))
        } catch (e: McpConnectionException) {
            Result.Error("MCP server not available: ${e.message}")
        } catch (e: Exception) {
            Result.Error("Failed to load navigation graph: ${e.message}")
        }
    }
}

// MCP response models for navigation graph

@Serializable
private data class NavigationGraphResponse(
    val appId: String? = null,
    val nodes: List<NavigationNodeDto> = emptyList(),
    val edges: List<NavigationEdgeDto> = emptyList(),
    val currentScreen: String? = null,
)

@Serializable
private data class NavigationNodeDto(
    val id: String? = null,
    val name: String? = null,
    val type: String? = null,
    val packageName: String? = null,
    val testCoverage: Int? = null,
    val transitionCount: Int? = null,
    val discoveredAt: Long? = null,
)

@Serializable
private data class NavigationEdgeDto(
    val id: String? = null,
    val from: String? = null,
    val to: String? = null,
    val trigger: String? = null,
    val element: String? = null,
    val avgLatencyMs: Int? = null,
    val failureRate: Float? = null,
)
