package dev.jasonpearson.automobile.desktop.core.datasource

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException
import dev.jasonpearson.automobile.desktop.core.daemon.decodeToolResponse
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import java.io.File
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer

private val LOG = LoggerFactory.getLogger("RealNetworkGraphDataSource")

/**
 * Real network-graph data source backed by the `getNetworkGraph` MCP tool (device-aware; embedded
 * SDK only). The tool returns an empty graph when no traffic was captured, which the facet renders
 * as an explicit empty state rather than an error.
 *
 * Artifact resolution: for external (non-internal) calls the daemon does NOT return the graph
 * inline — `finalizeToolResponse` replaces the `graph` array with artifact metadata (`{ artifact: {
 * path, format, ... } }`) and writes the real `GraphHost[]` JSON to a local file (see
 * `src/server/finalizeToolResponse.ts` `artifactNetworkGraphPayload`). Because the daemon is
 * co-located with the desktop app, we resolve the reference by reading that file from disk — the
 * same way the desktop consumes daemon-written video artifacts. The inline shape is still handled
 * for internal/older daemons that embed the array directly.
 *
 * @param clientProvider Function to provide an [AutoMobileClient] for MCP access
 * @param deviceId The device ID to fetch the network graph for
 * @param sinceSeconds Optional lookback window (forwarded to the tool)
 * @param minRequests Optional minimum request count per endpoint (forwarded to the tool)
 * @param readArtifactFile Reads a daemon-written artifact file by absolute path; injected so
 *   artifact resolution is unit-testable without touching the filesystem.
 */
class RealNetworkGraphDataSource(
  private val clientProvider: (() -> AutoMobileClient)? = null,
  private val deviceId: String? = null,
  private val sinceSeconds: Int? = null,
  private val minRequests: Int? = null,
  private val readArtifactFile: (String) -> String = { path -> File(path).readText() },
) : NetworkGraphDataSource {
  private val json = Json { ignoreUnknownKeys = true }
  private val hostListSerializer = ListSerializer(NetworkGraphHost.serializer())

  override suspend fun getNetworkGraph(): Result<List<NetworkEndpointRow>> {
    val provider =
      clientProvider
        ?: return Result.Error(
          IllegalStateException("Not connected to MCP server. Please select a device first.")
        )
    val device = deviceId ?: return Result.Error(IllegalStateException("No device ID provided"))

    return try {
      withContext(Dispatchers.IO) {
        val client = provider()
        val arguments = buildJsonObject {
          put("deviceId", device)
          sinceSeconds?.let { put("sinceSeconds", it) }
          minRequests?.let { put("minRequests", it) }
        }
        val toolElement = client.callTool("getNetworkGraph", arguments)
        val payload = decodeToolResponse(json, toolElement, serializer<JsonObject>())
        Result.Success(flattenNetworkGraph(resolveHosts(payload)))
      }
    } catch (e: McpConnectionException) {
      LOG.warn("getNetworkGraph: MCP connection error: ${e.message}", e)
      Result.Error(e, "MCP server not available: ${e.message}")
    } catch (e: Exception) {
      // Let coroutine cancellation propagate so this suspend call stays cancellable
      // (matches McpHttpClient's catch guard).
      if (e is CancellationException) throw e
      LOG.warn("getNetworkGraph: Exception: ${e.message}", e)
      Result.Error(e, "Failed to load network graph: ${e.message}")
    }
  }

  /**
   * Extract the `GraphHost[]` from the tool payload, resolving the artifact reference when the
   * graph was written to disk. Returns an empty list when the payload carries no graph (e.g. an
   * unexpected shape) so the facet can distinguish "no traffic" from a hard failure.
   */
  private fun resolveHosts(payload: JsonObject): List<NetworkGraphHost> {
    return when (val graph = payload["graph"]) {
      is JsonArray -> json.decodeFromJsonElement(hostListSerializer, graph)
      is JsonObject -> {
        val path =
          graph["artifact"]?.jsonObject?.get("path")?.jsonPrimitive?.content
            ?: throw McpConnectionException(
              "getNetworkGraph returned neither an inline graph nor an artifact path"
            )
        json.decodeFromString(hostListSerializer, readArtifactFile(path))
      }
      else -> emptyList()
    }
  }
}
