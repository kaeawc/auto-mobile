package dev.jasonpearson.automobile.desktop.core.datasource

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException
import dev.jasonpearson.automobile.desktop.core.daemon.encodeResourceUriComponent
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.serializer

private val LOG = LoggerFactory.getLogger("RealNetworkRequestsDataSource")

/**
 * Per-request network data source backed by the daemon's `automobile:network/traffic` resource (the
 * per-request event log) and the `automobile:network/request/{id}` detail resource.
 *
 * Reads are scoped to [deviceId] via the resource's `deviceId` query filter so a device pane never
 * shows another device's traffic. The traffic query keys must be emitted in the order the daemon
 * registers its templates (`limit` before `deviceId`, per `TRAFFIC_QUERY_KEYS` in
 * `src/server/networkResources.ts`), otherwise the anchored template regex will not match.
 *
 * @param clientProvider Provides an [AutoMobileClient] for MCP access.
 * @param deviceId The device to scope traffic reads to.
 * @param limit Max requests to fetch (daemon caps this at 200; default matches the daemon default).
 */
class RealNetworkRequestsDataSource(
  private val clientProvider: (() -> AutoMobileClient)? = null,
  private val deviceId: String? = null,
  private val limit: Int = DEFAULT_LIMIT,
) : NetworkRequestsDataSource {
  private val json = Json { ignoreUnknownKeys = true }

  override suspend fun getRequests(): Result<List<NetworkRequestRow>> {
    val provider =
      clientProvider
        ?: return Result.Error(
          IllegalStateException("Not connected to MCP server. Please select a device first.")
        )
    val device = deviceId ?: return Result.Error(IllegalStateException("No device ID provided"))

    return try {
      withContext(Dispatchers.IO) {
        val client = provider()
        val uri = buildTrafficUri(device, limit)
        val text =
          client.readResource(uri).firstOrNull()?.text
            ?: return@withContext Result.Success(emptyList())
        val response = json.decodeFromString(serializer<TrafficResponse>(), text)
        if (response.error != null) {
          return@withContext Result.Error(RuntimeException(response.error))
        }
        Result.Success(response.events.map { it.toRow() })
      }
    } catch (e: McpConnectionException) {
      LOG.warn("getRequests: MCP connection error: ${e.message}", e)
      Result.Error(e, "MCP server not available: ${e.message}")
    } catch (e: Exception) {
      // Let coroutine cancellation propagate so this suspend call stays cancellable.
      if (e is CancellationException) throw e
      LOG.warn("getRequests: Exception: ${e.message}", e)
      Result.Error(e, "Failed to load network requests: ${e.message}")
    }
  }

  override suspend fun getRequestDetail(id: Long): Result<NetworkRequestDetail> {
    val provider =
      clientProvider ?: return Result.Error(IllegalStateException("Not connected to MCP server."))

    return try {
      withContext(Dispatchers.IO) {
        val client = provider()
        val uri = "automobile:network/request/$id"
        val text =
          client.readResource(uri).firstOrNull()?.text
            ?: return@withContext Result.Error(
              RuntimeException("No detail returned for request $id")
            )
        val response = json.decodeFromString(serializer<RequestDetailResponse>(), text)
        // The true not-found/invalid envelope is `{ error }` with no `id` (getNetworkEventById
        // miss / invalid requestId). A transport-level request failure still returns a full
        // detail (valid id, headers, protocol) *with* a non-null `error`, so gate on the missing
        // id — NOT the presence of `error` — and surface that error inside the detail.
        if (response.id == 0L) {
          return@withContext Result.Error(
            RuntimeException(response.error ?: "Network request $id not found")
          )
        }
        Result.Success(response.toDetail())
      }
    } catch (e: McpConnectionException) {
      LOG.warn("getRequestDetail: MCP connection error: ${e.message}", e)
      Result.Error(e, "MCP server not available: ${e.message}")
    } catch (e: Exception) {
      if (e is CancellationException) throw e
      LOG.warn("getRequestDetail: Exception: ${e.message}", e)
      Result.Error(e, "Failed to load request detail: ${e.message}")
    }
  }

  private fun buildTrafficUri(deviceId: String, limit: Int): String {
    val encodedDevice = encodeResourceUriComponent(deviceId)
    return "automobile:network/traffic?limit=$limit&deviceId=$encodedDevice"
  }

  companion object {
    /** Matches the daemon's default traffic page size (`parseTrafficParams`). */
    const val DEFAULT_LIMIT = 50
  }
}
