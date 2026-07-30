package dev.jasonpearson.automobile.desktop.core.datasource

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException
import dev.jasonpearson.automobile.desktop.core.daemon.decodeToolResponse
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer

private val LOG = LoggerFactory.getLogger("RealNetworkGraphDataSource")

/**
 * Real network-graph data source backed by the `getNetworkGraph` MCP tool (device-aware; embedded
 * SDK only). The tool returns an empty graph when no traffic was captured, which the facet renders
 * as an explicit empty state rather than an error.
 *
 * @param clientProvider Function to provide an [AutoMobileClient] for MCP access
 * @param deviceId The device ID to fetch the network graph for
 * @param sinceSeconds Optional lookback window (forwarded to the tool)
 * @param minRequests Optional minimum request count per endpoint (forwarded to the tool)
 */
class RealNetworkGraphDataSource(
  private val clientProvider: (() -> AutoMobileClient)? = null,
  private val deviceId: String? = null,
  private val sinceSeconds: Int? = null,
  private val minRequests: Int? = null,
) : NetworkGraphDataSource {
  private val json = Json { ignoreUnknownKeys = true }

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
        val response = decodeToolResponse(json, toolElement, serializer<NetworkGraphResponse>())
        Result.Success(flattenNetworkGraph(response.graph))
      }
    } catch (e: McpConnectionException) {
      LOG.warn("getNetworkGraph: MCP connection error: ${e.message}", e)
      Result.Error(e, "MCP server not available: ${e.message}")
    } catch (e: Exception) {
      LOG.warn("getNetworkGraph: Exception: ${e.message}", e)
      Result.Error(e, "Failed to load network graph: ${e.message}")
    }
  }
}
