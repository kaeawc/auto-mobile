package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.UIElementInfo
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.serializer

/**
 * Converts the typed in-memory hierarchy ([UIElementInfo.children]) into the serialized wire
 * projection ([UIElementInfo.node]) exactly once, at the wire boundary (issue #5471).
 *
 * The extraction pipeline (optimize, all detectors, occlusion, focus search, hashing) walks the
 * typed [UIElementInfo.children] list and never touches [UIElementInfo.node]. Only when a snapshot
 * is about to be emitted does [materialize] run, building the whole `node` subtree in a single
 * O(nodes) pass.
 *
 * ## Byte-compatibility contract
 * The output must match the pre-refactor format exactly:
 * - A `UIElementInfo` serialized *directly* as a `ViewHierarchy` field (`hierarchy`,
 *   `accessibility-focused-element`) is emitted verbosely by the caller's `encodeDefaults = true`
 *   Json (every null field present).
 * - Everything nested under `node` is emitted *compactly* (null fields omitted), because the child
 *   subtree is pre-built here with an `encodeDefaults = false` Json — mirroring the old
 *   `encodeChildrenToNodeElement` behavior.
 *
 * [buildElementJson] encodes only a node's own scalar fields (children stripped) once per node and
 * then splices in the already-built child JSON, so the whole tree costs O(nodes) rather than the
 * O(nodes * depth) of repeatedly re-encoding whole subtrees.
 */
internal object WireNodeCodec {

  // encodeDefaults defaults to false, so nested nodes omit null fields — the compact child form the
  // wire has always used.
  private val compactJson = Json { ignoreUnknownKeys = true }

  private val elementSerializer = serializer<UIElementInfo>()

  /**
   * Returns a copy of [element] with [UIElementInfo.node] populated from its typed
   * [UIElementInfo.children]. Only the top-level element needs this — the returned [node] already
   * contains the entire nested subtree as JSON.
   */
  fun materialize(element: UIElementInfo): UIElementInfo =
    element.copy(node = buildNodeJson(element.children))

  /** Builds the `node` wire value for a child list: null (none), object (one), or array (many). */
  fun buildNodeJson(children: List<UIElementInfo>): JsonElement? =
    when {
      children.isEmpty() -> null
      children.size == 1 -> buildElementJson(children[0])
      else -> JsonArray(children.map { buildElementJson(it) })
    }

  private fun buildElementJson(element: UIElementInfo): JsonObject {
    // Encode this node's own fields only (compact, node absent because it is null here), then splice
    // in the recursively-built child JSON under "node" so it stays the last key, matching the
    // declaration-order emission the wire has always produced.
    val scalars = compactJson.encodeToJsonElement(elementSerializer, element) as JsonObject
    val childJson = buildNodeJson(element.children) ?: return scalars
    return JsonObject(scalars + ("node" to childJson))
  }
}
