package dev.jasonpearson.automobile.ctrlproxy

import android.util.Log
import dev.jasonpearson.automobile.ctrlproxy.ViewHierarchyExtractor.WindowEntry
import dev.jasonpearson.automobile.ctrlproxy.models.ElementBounds
import dev.jasonpearson.automobile.ctrlproxy.models.UIElementInfo
import kotlin.math.max

/** Cross-window coverage over already captured nodes; never owns framework nodes. */
internal class OcclusionCalculator(
  private val stats: CtrlProxyWorkStats,
  private val generateDeterministicUuid: (String) -> String,
) {
  companion object {
    private const val TAG = "ViewHierarchyExtractor"
    private const val OCCLUSION_THRESHOLD = 0.95
    private const val OCCLUSION_BUCKET_WIDTH = 128
    private const val MAX_OCCLUSION_BUCKET_SPAN = 64
  }

  private data class OrderCounter(var value: Int = 0)

  internal data class NodeKey(val windowKey: Int, val path: String)

  private data class OcclusionNode(
    val key: NodeKey,
    val element: UIElementInfo,
    val bounds: ElementBounds,
    val windowLayer: Int,
    val windowKey: Int,
    val order: Int,
    val subtreeEnd: Int,
  )

  internal data class OcclusionInfo(
    val coverage: Double,
    val occludedBy: String?,
    val occludedByViewId: String?,
  )

  private data class OcclusionWindowIndex(
    val lastIndex: Int,
    val all: List<OcclusionBoundsGroup>,
    val buckets: Map<Int, List<OcclusionBoundsGroup>>,
    val wide: List<OcclusionBoundsGroup>,
  )

  /**
   * Identical rectangles have the same intersection and union contribution. Keep their sorted
   * entries so a query can retain the first eligible label when equal-layer windows interleave.
   */
  private data class OcclusionBoundsGroup(
    val bounds: ElementBounds,
    val entries: List<IndexedValue<OcclusionNode>>,
  ) {
    fun firstAfter(index: Int): IndexedValue<OcclusionNode>? {
      var low = 0
      var high = entries.size
      while (low < high) {
        val middle = (low + high) ushr 1
        if (entries[middle].index <= index) low = middle + 1 else high = middle
      }
      return entries.getOrNull(low)
    }
  }

  private fun occlusionBuckets(bounds: ElementBounds): IntRange? {
    val first = bounds.left / OCCLUSION_BUCKET_WIDTH
    val last = (bounds.right - 1) / OCCLUSION_BUCKET_WIDTH
    return if (last.toLong() - first.toLong() >= MAX_OCCLUSION_BUCKET_SPAN) null else first..last
  }

  /** Accumulates depth-first order independently for each captured window. */
  private data class NodeCollection(
    val nodes: MutableList<OcclusionNode>,
    val orderCounter: OrderCounter = OrderCounter(),
  )

  fun buildOcclusionInfo(windowEntries: List<WindowEntry>): Map<NodeKey, OcclusionInfo> {
    val nodes = mutableListOf<OcclusionNode>()
    val windowBoundsByKey = windowEntries.associate { it.windowId to it.windowBounds }
    val imeWindowKeys =
      windowEntries
        .asSequence()
        .filter { it.windowType == "input_method" }
        .mapTo(mutableSetOf()) {
          it.windowId
        }
    // The host decides what CtrlProxy's own prototype covers
    // (OwnWindowCoverRule in isFullyCoveredByApplicationWindow, layer:"app", covered-tap refusal),
    // so
    // its windows must not prune the app nodes beneath them
    // here; dropping those nodes left the host nothing to scope or refuse (#10608/#10544).
    val ownPrototypeWindowKeys =
      windowEntries
        .asSequence()
        .filter { it.isOwnPrototype }
        .mapTo(mutableSetOf()) {
          it.windowId
        }
    for (windowEntry in windowEntries) {
      val hierarchy = windowEntry.hierarchy
      val windowKey = windowEntry.windowId
      val windowLayer = windowEntry.windowLayer
      collectOcclusionNodes(
        hierarchy,
        windowKey,
        windowLayer,
        path = "",
        collection = NodeCollection(nodes),
      )
    }

    if (nodes.isEmpty()) {
      return emptyMap()
    }

    val sortedNodes =
      nodes.sortedWith(compareBy<OcclusionNode> { it.windowLayer }.thenBy { it.order })
    // Index cross-window candidates spatially and collapse identical rectangles within each
    // window. A dense accessibility tree can repeat a full-screen bound hundreds of times; only
    // the first eligible rectangle affects coverage or the tie-broken occluder label.
    val nodesByWindow = buildIndex(sortedNodes, windowBoundsByKey)
    val pass = CoveragePass(nodesByWindow, imeWindowKeys, ownPrototypeWindowKeys)
    for (i in sortedNodes.indices) pass.compute(sortedNodes[i], i)
    stats.occlusionIndexEntriesVisited.addAndGet(pass.indexEntriesVisited)
    return pass.occlusionInfo
  }

  private fun buildIndex(
    sortedNodes: List<OcclusionNode>,
    windowBoundsByKey: Map<Int, ElementBounds?>,
  ): Map<Int, OcclusionWindowIndex> {
    return sortedNodes
      .withIndex()
      .groupBy { it.value.windowKey }
      .mapValues { (windowKey, entries) ->
        val groups =
          entries
            .groupBy {
              OcclusionGeometry.clipOccluderBounds(it.value.bounds, windowBoundsByKey[windowKey])
            }
            .mapNotNull { (bounds, matches) ->
              bounds?.let { OcclusionBoundsGroup(it, matches) }
            }
        val buckets = mutableMapOf<Int, MutableList<OcclusionBoundsGroup>>()
        val wide = mutableListOf<OcclusionBoundsGroup>()
        for (group in groups) {
          val span = occlusionBuckets(group.bounds)
          if (span == null) wide.add(group)
          else for (bucket in span) buckets.getOrPut(bucket) { mutableListOf() }.add(group)
        }
        OcclusionWindowIndex(entries.last().index, groups, buckets, wide)
      }
  }

  private inner class CoveragePass(
    val nodesByWindow: Map<Int, OcclusionWindowIndex>,
    val imeWindowKeys: Set<Int>,
    val ownPrototypeWindowKeys: Set<Int>,
  ) {
    val occlusionInfo = mutableMapOf<NodeKey, OcclusionInfo>()
    var indexEntriesVisited = 0L

    fun compute(node: OcclusionNode, i: Int) {
      val totalArea = node.bounds.width * node.bounds.height
      if (totalArea <= 0) return

      // Debug: Track occlusion for text nodes
      val isDebugNode = node.element.text == "Tap" || node.element.text == "Discover"
      if (isDebugNode) {
        Log.d(
          TAG,
          "[OCCLUSION] Node text='${node.element.text}', bounds=${node.bounds}, path='${node.key.path}', order=${node.order}, subtreeEnd=${node.subtreeEnd}",
        )
      }

      val coverage = NodeCoverage(node, imeWindowKeys, ownPrototypeWindowKeys)
      val candidates = candidates(node, i)
      for ((candidate, occluderBounds) in candidates.sortedBy { it.first.index }) {
        coverage.consider(candidate, occluderBounds, isDebugNode)
      }
      coverage.finish(totalArea, isDebugNode)?.let { occlusionInfo[node.key] = it }
    }

    private fun candidates(
      node: OcclusionNode,
      i: Int,
    ): List<Pair<IndexedValue<OcclusionNode>, ElementBounds>> {
      val candidates = mutableListOf<Pair<IndexedValue<OcclusionNode>, ElementBounds>>()
      val nodeBuckets = occlusionBuckets(node.bounds)
      for ((windowKey, windowIndex) in nodesByWindow) {
        if (windowKey == node.windowKey || windowIndex.lastIndex <= i) continue
        // A query spanning several buckets is cheaper to scan once against the window index.
        // For narrow queries, stream bucket entries so duplicates never form a flattened list.
        val possible =
          if (nodeBuckets == null || nodeBuckets.last - nodeBuckets.first >= 3) {
            windowIndex.all.asSequence()
          } else {
            sequence {
              yieldAll(windowIndex.wide)
              for (bucket in nodeBuckets) yieldAll(windowIndex.buckets[bucket].orEmpty())
            }
          }
        val seen = mutableSetOf<ElementBounds>()
        for (group in possible) {
          indexEntriesVisited++
          if (!seen.add(group.bounds)) continue
          val entry = group.firstAfter(i) ?: continue
          val bounds = group.bounds
          val overlapsLaterNode = overlapsLaterNode(entry, bounds, node, i)
          if (overlapsLaterNode) {
            candidates.add(entry to bounds)
          }
        }
      }
      return candidates
    }
  }

  private fun overlapsLaterNode(
    entry: IndexedValue<OcclusionNode>,
    bounds: ElementBounds,
    node: OcclusionNode,
    i: Int,
  ): Boolean {
    return entry.index > i &&
      bounds.left < node.bounds.right &&
      bounds.right > node.bounds.left &&
      bounds.top < node.bounds.bottom &&
      bounds.bottom > node.bounds.top
  }

  private inner class NodeCoverage(
    val node: OcclusionNode,
    val imeWindowKeys: Set<Int>,
    val ownPrototypeWindowKeys: Set<Int>,
  ) {
    val intersections = mutableListOf<ElementBounds>()
    var maxOverlap = 0
    var occludedBy: String? = null
    var occludedByViewId: String? = null

    fun consider(
      candidate: IndexedValue<OcclusionNode>,
      occluderBounds: ElementBounds,
      isDebugNode: Boolean,
    ) {
      val occluder = candidate.value
      stats.occlusionCandidateComparisons.incrementAndGet()
      // Skip cross-window IME occluders: the IME's a11y root has a transparent wrapper that
      // overstates the keyboard rectangle and would falsely mark the app underneath as hidden.
      // Same-window IME-vs-IME occlusion is preserved by the `windowKey != node.windowKey` guard.
      // CtrlProxy's own prototype windows are skipped the same way (see above).
      if (
        occluder.windowKey != node.windowKey &&
          (occluder.windowKey in imeWindowKeys || occluder.windowKey in ownPrototypeWindowKeys)
      ) {
        return
      }
      val intersection = OcclusionGeometry.intersectBounds(node.bounds, occluderBounds) ?: return
      val overlapArea = intersection.width * intersection.height
      if (overlapArea <= 0) return

      if (isDebugNode) {
        Log.d(
          TAG,
          "[OCCLUSION]   Occluder: text='${occluder.element.text}', bounds=$occluderBounds, overlap=$overlapArea, order=${occluder.order}",
        )
      }

      intersections.add(intersection)

      if (overlapArea > maxOverlap) {
        maxOverlap = overlapArea
        occludedBy = resolveOccluderLabel(occluder)
        occludedByViewId =
          resolveViewIdForOcclusionNode(
            occluder.element,
            occluder.key.windowKey,
            occluder.key.path,
          )
      }
    }

    fun finish(totalArea: Int, isDebugNode: Boolean): OcclusionInfo? {

      if (intersections.isNotEmpty()) {
        val coveredArea =
          OcclusionGeometry.calculateUnionArea(
            intersections,
            maxArea = (totalArea * OCCLUSION_THRESHOLD).toInt(),
          )
        val coverage = coveredArea.toDouble() / totalArea.toDouble()
        if (isDebugNode) {
          Log.d(
            TAG,
            "[OCCLUSION]   Result: coverage=$coverage (${(coverage*100).toInt()}%), threshold=$OCCLUSION_THRESHOLD, coveredArea=$coveredArea, totalArea=$totalArea",
          )
        }
        if (coverage > 0.0) {
          return OcclusionInfo(
            coverage = coverage,
            occludedBy = occludedBy,
            occludedByViewId = occludedByViewId,
          )
        }
      }
      return null
    }
  }

  private fun collectOcclusionNodes(
    element: UIElementInfo,
    windowKey: Int,
    windowLayer: Int,
    path: String,
    collection: NodeCollection,
  ): Int {
    val start = collection.orderCounter.value++
    var end = start
    val children = element.children

    for ((index, child) in children.withIndex()) {
      val childPath = if (path.isBlank()) index.toString() else "$path.$index"
      val childEnd = collectOcclusionNodes(child, windowKey, windowLayer, childPath, collection)
      end = max(end, childEnd)
    }

    val bounds = element.bounds
    if (bounds != null && !bounds.hasZeroArea()) {
      collection.nodes.add(
        OcclusionNode(
          key = NodeKey(windowKey, path),
          element = element,
          bounds = bounds,
          windowLayer = windowLayer,
          windowKey = windowKey,
          order = start,
          subtreeEnd = end,
        ),
      )
    }

    return end
  }

  fun filterOccludedHierarchy(
    element: UIElementInfo,
    occlusionInfo: Map<NodeKey, OcclusionInfo>,
    windowKey: Int,
    path: String,
    isRoot: Boolean,
  ): UIElementInfo? {
    val key = NodeKey(windowKey, path)
    val info = occlusionInfo[key]
    val occlusionState =
      when {
        info == null -> null
        info.coverage >= OCCLUSION_THRESHOLD -> "hidden"
        info.coverage > 0.0 -> "partial"
        else -> null
      }

    // Debug logging for Tab text nodes
    if (element.text == "Tap" || element.text == "Discover") {
      Log.d(
        TAG,
        "[FILTER] text='${element.text}', path='$path', state=$occlusionState, coverage=${info?.coverage}, occludedBy='${info?.occludedBy}'",
      )
    }

    val filteredChildren =
      element.children.mapIndexedNotNull { index, child ->
        val childPath = if (path.isBlank()) index.toString() else "$path.$index"
        filterOccludedHierarchy(child, occlusionInfo, windowKey, childPath, isRoot = false)
      }

    if (occlusionState == "hidden" && !isRoot) {
      if (element.text == "Tap" || element.text == "Discover") {
        Log.d(TAG, "[FILTER] -> REMOVED text='${element.text}'")
      }
      return null
    }

    return element.copy(
      viewId = resolveViewIdForOcclusionNode(element, windowKey, path),
      children = filteredChildren,
      occlusionState = occlusionState,
      occludedBy = info?.occludedBy,
      occludedByViewId = info?.occludedByViewId,
    )
  }

  private fun resolveOccluderLabel(occluder: OcclusionNode): String {
    val element = occluder.element
    return element.resourceId?.takeIf { it.isNotBlank() }
      ?: element.contentDesc?.takeIf { it.isNotBlank() }
      ?: element.text?.takeIf { it.isNotBlank() }
      ?: element.className?.takeIf { it.isNotBlank() }
      ?: "unlabeled view"
  }

  private fun resolveViewIdForOcclusionNode(
    element: UIElementInfo,
    windowKey: Int,
    path: String,
  ): String {
    return element.viewId?.takeIf { it.isNotBlank() }
      ?: generateDeterministicUuid("occlusion/window:$windowKey/path:$path")
  }
}
