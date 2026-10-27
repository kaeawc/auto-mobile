package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeDataResolver
import dev.jasonpearson.automobile.protocol.PrototypeNode
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeStackSnapshot
import dev.jasonpearson.automobile.protocol.PrototypeStrings
import java.util.IdentityHashMap
import kotlinx.serialization.json.JsonObject

/** Static validation and repeat binding belong to one resolved root, with identity-based keys. */
internal class PrototypeRenderCache(
  val root: PrototypeNode,
  private val formatter: PrototypeValueFormatter = AndroidPrototypeValueFormatter(),
) {
  private val entries =
    IdentityHashMap<PrototypeNode, MutableMap<String, List<PrototypeChildEntry>>>()

  init {
    guardPrototypeTree(root)
  }

  fun children(node: PrototypeNode, path: String): List<PrototypeChildEntry> =
    entries
      .getOrPut(node) { mutableMapOf() }
      .getOrPut(path) { validatedPrototypeChildren(node, path, formatter) }
}

/**
 * One snapshot mapping, shared by the controller and Compose. Each actual pass computes all values
 * bottom-up, then interns against the preceding pass; it never guesses a node's state dependencies.
 */
internal class PrototypeRenderMapper(
  private val formatter: PrototypeValueFormatter = AndroidPrototypeValueFormatter(),
) {
  private val lock = Any()
  private val checked = PrototypeCheckedNodeCache(formatter)
  private var locale: java.util.Locale? = null
  private var zone: String? = null
  private var authoredSpec: PrototypeSpec? = null
  private var sourceLocales: List<String>? = null
  private var sourceStrings: JsonObject? = null
  private var authoredLocales: List<String>? = null
  private var resolvedSpec: PrototypeSpec? = null
  private var sourceRoot: PrototypeNode? = null
  private var sourceData: JsonObject? = null
  private var sourcePlatform: JsonObject? = null
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

  @Suppress("LongParameterList") // Mirrors the runtime snapshot the model is derived from.
  fun map(
    spec: PrototypeSpec,
    pages: Map<String, Int>,
    stacks: Map<String, PrototypeStackSnapshot> = emptyMap(),
    shownErrors: Set<String> = emptySet(),
    platform: JsonObject? = null,
    locales: List<String> = emptyList(),
  ): PrototypeRenderModel =
    synchronized(lock) {
      val currentLocale = java.util.Locale.getDefault()
      val currentZone = java.util.TimeZone.getDefault().id
      if (locale != currentLocale || zone != currentZone) {
        cache = null
        previousModel = null
        locale = currentLocale
        zone = currentZone
      }
      val resolved = resolveLocked(spec, platform, locales)
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
          cache?.takeIf { it.root === resolved.root }
            ?: PrototypeRenderCache(resolved.root, formatter)
        val mapping =
          PrototypeNodeMapping(
            state = resolved.state.orEmpty(),
            pages = pages,
            cache = static,
            previous = previousNodes,
            stacks = stacks,
            validity =
              prototypeValidity(
                checked.nodes(resolved),
                resolved.state.orEmpty(),
              ),
            shownErrors = shownErrors,
            data = resolved.data,
            derive = resolved.derive.orEmpty(),
            formatter = formatter,
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

  private fun resolvedFromSameSources(
    spec: PrototypeSpec,
    platform: JsonObject?,
    locales: List<String>,
  ): Boolean =
    sourceRoot === spec.root &&
      sourceData === spec.data &&
      sourceStrings === spec.strings &&
      sourceLocales == locales &&
      sourcePlatform == platform

  /**
   * Called only under [lock]; state writes preserve authored root, data, locale and platform
   * identities.
   */
  private fun resolveLocked(
    spec: PrototypeSpec,
    platform: JsonObject?,
    locales: List<String>,
  ): PrototypeSpec {
    if (authoredSpec === spec && authoredLocales == locales && sourcePlatform == platform)
      return checkNotNull(resolvedSpec)
    val root =
      if (resolvedFromSameSources(spec, platform, locales)) checkNotNull(resolvedRoot)
      else {
        PrototypeStrings.resolve(PrototypeDataResolver.resolve(spec, platform), locales).root.also {
          sourceLocales = locales.toList()
          sourceStrings = spec.strings
          sourcePlatform = platform
          sourceRoot = spec.root
          sourceData = spec.data
          resolvedRoot = it
        }
      }
    val resolved = if (root === spec.root) spec else spec.copy(root = root)
    authoredSpec = spec
    authoredLocales = locales.toList()
    resolvedSpec = resolved
    return resolved
  }
}
