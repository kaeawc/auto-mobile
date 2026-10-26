package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeDataResolver
import dev.jasonpearson.automobile.protocol.PrototypeNode
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeStackSnapshot
import java.util.IdentityHashMap
import kotlinx.serialization.json.JsonObject

/** Static validation and repeat binding belong to one resolved root, with identity-based keys. */
internal class PrototypeRenderCache(val root: PrototypeNode) {
  private val entries =
    IdentityHashMap<PrototypeNode, MutableMap<String, List<PrototypeChildEntry>>>()

  init {
    guardPrototypeTree(root)
  }

  fun children(node: PrototypeNode, path: String): List<PrototypeChildEntry> =
    entries
      .getOrPut(node) { mutableMapOf() }
      .getOrPut(path) { validatedPrototypeChildren(node, path) }
}

/**
 * One snapshot mapping, shared by the controller and Compose. Each actual pass computes all values
 * bottom-up, then interns against the preceding pass; it never guesses a node's state dependencies.
 */
internal class PrototypeRenderMapper {
  private val lock = Any()
  private var authoredSpec: PrototypeSpec? = null
  private var resolvedSpec: PrototypeSpec? = null
  private var sourceRoot: PrototypeNode? = null
  private var sourceData: JsonObject? = null
  private var resolvedRoot: PrototypeNode? = null
  private var cache: PrototypeRenderCache? = null
  private var previousSpec: PrototypeSpec? = null
  private var previousShownErrors: Set<String>? = null
  private var previousPages: Map<String, Int>? = null
  private var previousStacks: Map<String, PrototypeStackSnapshot>? = null
  private var previousModel: PrototypeRenderModel? = null
  private var previousNodes: Map<String, PrototypeRenderNode> = emptyMap()
  private var passes = 0

  internal val mappingPasses: Int
    get() = synchronized(lock) { passes }

  internal val lastResolvedSpec: PrototypeSpec?
    get() = synchronized(lock) { resolvedSpec }

  fun map(
    spec: PrototypeSpec,
    pages: Map<String, Int>,
    stacks: Map<String, PrototypeStackSnapshot> = emptyMap(),
    shownErrors: Set<String> = emptySet(),
  ): PrototypeRenderModel =
    synchronized(lock) {
      val resolved = resolveLocked(spec)
      previousModel?.let { model ->
        if (
          previousSpec?.root === resolved.root &&
            previousSpec == resolved &&
            previousPages == pages &&
            previousStacks == stacks &&
            previousShownErrors == shownErrors
        ) {
          return@synchronized model
        }
      }
      PrototypeTrace.section(PrototypeTrace.MAP_RENDER_TREE) {
        val static =
          cache?.takeIf { it.root === resolved.root } ?: PrototypeRenderCache(resolved.root)
        val mapping =
          PrototypeNodeMapping(
            state = resolved.state.orEmpty(),
            pages = pages,
            cache = static,
            previous = previousNodes,
            stacks = stacks,
            validity =
              prototypeValidity(
                checkedPrototypeNodes(resolved.root, resolved.data),
                resolved.state.orEmpty(),
              ),
            shownErrors = shownErrors,
            data = resolved.data,
          )
        val model = prototypeRenderModel(resolved, mapping.map(resolved.root, "root"))
        cache = static
        previousSpec = resolved
        previousPages = pages
        previousStacks = stacks
        previousShownErrors = shownErrors
        previousModel = model
        previousNodes = mapping.nodes
        passes++
        model
      }
    }

  /** Called only under [lock]; state writes preserve both authored cache keys. */
  private fun resolveLocked(spec: PrototypeSpec): PrototypeSpec {
    if (authoredSpec === spec) return checkNotNull(resolvedSpec)
    val root =
      if (sourceRoot === spec.root && sourceData === spec.data) checkNotNull(resolvedRoot)
      else {
        PrototypeDataResolver.resolve(spec).root.also {
          sourceRoot = spec.root
          sourceData = spec.data
          resolvedRoot = it
        }
      }
    val resolved = if (root === spec.root) spec else spec.copy(root = root)
    authoredSpec = spec
    resolvedSpec = resolved
    return resolved
  }
}
