package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeNode
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import java.util.IdentityHashMap

/** Static validation and repeat binding belong to one authored root, with identity-based keys. */
internal class PrototypeRenderCache(val root: PrototypeNode) {
  private val entries =
    IdentityHashMap<PrototypeNode, MutableMap<String, List<PrototypeChildEntry>>>()

  init {
    guardPrototypeTree(root)
  }

  fun children(node: PrototypeNode, path: String): List<PrototypeChildEntry> =
    entries
      .getOrPut(node) { mutableMapOf() }
      .getOrPut(path) {
        validatedPrototypeChildren(node, path)
      }
}

/**
 * One snapshot mapping, shared by the controller and Compose. Each actual pass computes all values
 * bottom-up, then interns against the preceding pass; it never guesses a node's state dependencies.
 */
internal class PrototypeRenderMapper {
  private val lock = Any()
  private var cache: PrototypeRenderCache? = null
  private var previousSpec: PrototypeSpec? = null
  private var previousPages: Map<String, Int>? = null
  private var previousModel: PrototypeRenderModel? = null
  private var previousNodes: Map<String, PrototypeRenderNode> = emptyMap()
  private var passes = 0

  internal val mappingPasses: Int
    get() = synchronized(lock) { passes }

  fun map(spec: PrototypeSpec, pages: Map<String, Int>): PrototypeRenderModel =
    synchronized(lock) {
      previousModel?.let { model ->
        if (previousSpec?.root === spec.root && previousSpec == spec && previousPages == pages) {
          return@synchronized model
        }
      }
      PrototypeTrace.section(PrototypeTrace.MAP_RENDER_TREE) {
        val static = cache?.takeIf { it.root === spec.root } ?: PrototypeRenderCache(spec.root)
        val mapping = PrototypeNodeMapping(spec.state.orEmpty(), pages, static, previousNodes)
        val model = prototypeRenderModel(spec, mapping.map(spec.root, "root"))
        cache = static
        previousSpec = spec
        previousPages = pages
        previousModel = model
        previousNodes = mapping.nodes
        passes++
        model
      }
    }
}
