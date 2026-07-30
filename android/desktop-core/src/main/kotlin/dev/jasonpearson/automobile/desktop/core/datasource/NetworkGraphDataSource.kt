package dev.jasonpearson.automobile.desktop.core.datasource

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * A single captured endpoint, flattened out of the `getNetworkGraph` host → path tree into one row
 * per method+path so the first-cut facet can render a flat list. [path] is the joined path segments
 * (parameterized segments preserved as their `{id}` marker); [method]/[type] come from the leaf.
 */
data class NetworkEndpointRow(
  val scheme: String,
  val host: String,
  val path: String,
  val method: String?,
  val type: String?,
  val success: Int,
  val errors: Int,
  val p50: Int,
  val p95: Int,
)

/**
 * Reads the aggregate captured network graph for a device. Returns already-flattened endpoint rows
 * so the facet stays a dumb renderer. Injected as an interface so the facet is testable without a
 * live MCP daemon (see [FakeNetworkGraphDataSource]).
 */
interface NetworkGraphDataSource {
  suspend fun getNetworkGraph(): Result<List<NetworkEndpointRow>>
}

/** Test double: returns a canned result (default: an empty graph). */
class FakeNetworkGraphDataSource(
  private val result: Result<List<NetworkEndpointRow>> = Result.Success(emptyList())
) : NetworkGraphDataSource {
  override suspend fun getNetworkGraph(): Result<List<NetworkEndpointRow>> = result
}

// --- MCP response models (mirror src/server/networkGraph.ts NetworkGraph) ---

/** Top-level `getNetworkGraph` payload: `{ graph: GraphHost[] }`. */
@Serializable data class NetworkGraphResponse(val graph: List<NetworkGraphHost> = emptyList())

/**
 * One host in the graph. `paths` is a dynamically keyed `Record<string, GraphNode>` where a node is
 * a leaf (has `success`), a branch (has `paths`), or both — so it is kept as raw [JsonElement] and
 * walked structurally by [flattenNetworkGraph] rather than modeled as a sealed union.
 */
@Serializable
data class NetworkGraphHost(
  val scheme: String = "https",
  val host: String = "",
  val paths: Map<String, JsonElement> = emptyMap(),
)

private val METHOD_SUFFIX = Regex("""\[[^\]]*\]$""")

/** Strip the trailing `[GET]`/`[POST]` method disambiguator the daemon appends to leaf keys. */
private fun stripMethodSuffix(key: String): String = key.replace(METHOD_SUFFIX, "")

private fun JsonObject.intField(name: String): Int = this[name]?.jsonPrimitive?.intOrNull ?: 0

private fun JsonObject.stringField(name: String): String? = this[name]?.jsonPrimitive?.content

/**
 * Walk the host → path tree, emitting one [NetworkEndpointRow] per leaf (a node carrying a
 * `success` count). Recurses into any `paths` branch, accumulating path segments. Pure so the
 * flattening is unit-testable independent of MCP.
 */
fun flattenNetworkGraph(hosts: List<NetworkGraphHost>): List<NetworkEndpointRow> {
  val rows = mutableListOf<NetworkEndpointRow>()
  for (host in hosts) {
    walkPaths(host.scheme, host.host, host.paths, emptyList(), rows)
  }
  return rows
}

private fun walkPaths(
  scheme: String,
  host: String,
  paths: Map<String, JsonElement>,
  segments: List<String>,
  out: MutableList<NetworkEndpointRow>,
) {
  for ((key, element) in paths) {
    val node = element as? JsonObject ?: continue
    val nested = node["paths"] as? JsonObject
    // The server appends `[METHOD]` only to pure-leaf keys (`insertIntoTree`); branch and
    // leaf+branch keys stay literal. So strip the method suffix only when this node has no
    // children — otherwise a real bracketed segment like `items[archived]` would be mangled.
    val segment = if (nested != null) key else stripMethodSuffix(key)
    val nextSegments = if (segment.isEmpty()) segments else segments + segment
    if (node.containsKey("success")) {
      out.add(
        NetworkEndpointRow(
          scheme = scheme,
          host = host,
          path = "/" + nextSegments.joinToString("/"),
          method = node.stringField("method"),
          type = node.stringField("type"),
          success = node.intField("success"),
          errors = node.intField("errors"),
          p50 = node.intField("p50"),
          p95 = node.intField("p95"),
        )
      )
    }
    if (nested != null) {
      walkPaths(scheme, host, nested, nextSegments, out)
    }
  }
}
