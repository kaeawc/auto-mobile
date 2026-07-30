package dev.jasonpearson.automobile.desktop.core.datasource

import kotlinx.serialization.Serializable

/**
 * A single captured network request, projected from the daemon's `automobile:network/traffic`
 * resource (the per-request event log, not the aggregated `getNetworkGraph` tree). One row per
 * captured HTTP call. [id] is the daemon-side event id, used to fetch the [NetworkRequestDetail].
 */
data class NetworkRequestRow(
  val id: Long,
  val method: String,
  val host: String,
  val path: String,
  val statusCode: Int,
  val durationMs: Long,
  val timestamp: Long,
  val contentType: String?,
  val error: String?,
)

/**
 * Request/response detail for a single captured call, projected from
 * `automobile:network/request/{id}`. Carries the header maps and timing the detail pane renders.
 * Bodies are available in the resource but intentionally omitted from this first cut (see the issue
 * follow-ups).
 */
data class NetworkRequestDetail(
  val id: Long,
  val method: String,
  val url: String,
  val host: String,
  val path: String,
  val statusCode: Int,
  val durationMs: Long,
  val protocol: String?,
  val contentType: String?,
  val requestHeaders: Map<String, String>,
  val responseHeaders: Map<String, String>,
  val error: String?,
)

/**
 * Reads per-request captured network events for a single device. Injected as an interface so the
 * facet is testable without a live MCP daemon (see [FakeNetworkRequestsDataSource]). Mirrors the
 * [NetworkGraphDataSource] seam but resolves per-request rows rather than the aggregated graph.
 */
interface NetworkRequestsDataSource {
  /** Latest captured requests for this device, newest first. */
  suspend fun getRequests(): Result<List<NetworkRequestRow>>

  /** Full request/response detail (headers/timing) for a captured event [id]. */
  suspend fun getRequestDetail(id: Long): Result<NetworkRequestDetail>
}

/** Test double: returns canned results (default: an empty request list). */
class FakeNetworkRequestsDataSource(
  private val requests: Result<List<NetworkRequestRow>> = Result.Success(emptyList()),
  private val details: Map<Long, Result<NetworkRequestDetail>> = emptyMap(),
) : NetworkRequestsDataSource {
  override suspend fun getRequests(): Result<List<NetworkRequestRow>> = requests

  override suspend fun getRequestDetail(id: Long): Result<NetworkRequestDetail> =
    details[id] ?: Result.Error(IllegalStateException("No detail configured for request $id"))
}

// --- MCP response models (mirror src/server/networkResources.ts eventToSummary/eventToDetail) ---

/**
 * `automobile:network/traffic` payload: `{ events: EventSummary[], count, hasMore }`. A failed
 * query returns `{ error }` instead, which the data source surfaces as a typed failure. Nullable
 * string fields mirror the daemon shape — `host`/`path`/`contentType`/`error` are `null` when
 * absent.
 */
@Serializable
data class TrafficResponse(
  val events: List<TrafficEventSummary> = emptyList(),
  val error: String? = null,
)

@Serializable
data class TrafficEventSummary(
  val id: Long = 0,
  val timestamp: Long = 0,
  val method: String = "",
  val url: String? = null,
  val host: String? = null,
  val path: String? = null,
  val statusCode: Int = 0,
  val durationMs: Long = 0,
  val contentType: String? = null,
  val error: String? = null,
)

/**
 * `automobile:network/request/{id}` payload (eventToDetail). Header maps are `null` when the event
 * carried no headers. A `{ error }` shape (invalid/missing id) is surfaced as a typed failure.
 */
@Serializable
data class RequestDetailResponse(
  val id: Long = 0,
  val method: String = "",
  val url: String? = null,
  val host: String? = null,
  val path: String? = null,
  val statusCode: Int = 0,
  val durationMs: Long = 0,
  val protocol: String? = null,
  val contentType: String? = null,
  val requestHeaders: Map<String, String>? = null,
  val responseHeaders: Map<String, String>? = null,
  val error: String? = null,
)

/** Project a wire summary into a table row, coalescing absent host/path to empty strings. */
fun TrafficEventSummary.toRow(): NetworkRequestRow =
  NetworkRequestRow(
    id = id,
    method = method,
    host = host ?: "",
    path = path ?: "",
    statusCode = statusCode,
    durationMs = durationMs,
    timestamp = timestamp,
    contentType = contentType,
    error = error,
  )

/** Project a wire detail into the detail model, coalescing absent header maps to empty. */
fun RequestDetailResponse.toDetail(): NetworkRequestDetail =
  NetworkRequestDetail(
    id = id,
    method = method,
    url = url ?: "",
    host = host ?: "",
    path = path ?: "",
    statusCode = statusCode,
    durationMs = durationMs,
    protocol = protocol,
    contentType = contentType,
    requestHeaders = requestHeaders ?: emptyMap(),
    responseHeaders = responseHeaders ?: emptyMap(),
    error = error,
  )
