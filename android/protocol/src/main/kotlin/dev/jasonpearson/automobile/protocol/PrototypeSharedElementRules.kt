package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonObject

/** Cross-node constraints in contract pre-order, after structural validation. */
internal object PrototypeSharedElementRules {
  private data class Occurrence(
    val path: String,
    val at: String,
    val boundary: String,
    val kind: String,
    val templated: Boolean,
    val repeatPath: String?,
  )

  fun error(context: PrototypeStateChecks.Context): PrototypeSpecError? {
    PrototypeStackPatternRules.error(context)?.let {
      return it
    }
    val sources = PrototypeStackPatternRules.sources(context)
    val pairs = linkedMapOf<String, MutableList<Occurrence>>()
    val glassKeys = mutableMapOf<String, MutableSet<String>>()
    for (located in context.nodes) {
      addNode(context, located, pairs, sources, glassKeys)?.let {
        return it
      }
    }
    for ((key, entries) in pairs) {
      if (entries.size != 2 && !entries.first().templated)
        return fail(entries.first().at, pairMessage(key))
    }
    return null
  }

  private fun addNode(
    context: PrototypeStateChecks.Context,
    located: PrototypeStateChecks.Located,
    pairs: MutableMap<String, MutableList<Occurrence>>,
    sources: Set<String>,
    glassKeys: MutableMap<String, MutableSet<String>>,
  ): PrototypeSpecError? {
    val (node, path) = located
    val shared = node["shared"] as? JsonObject
    val key = shared?.text("key") ?: node.text("sharedKey") ?: return null
    val at = "$path.${if (shared != null) "shared.key" else "sharedKey"}"
    if (shared != null && "sharedKey" in node)
      return fail("$path.shared", "shared and sharedKey cannot both be set")
    val group = PrototypeGlassRules.sharedGroup(node, path, context.nodes)
    val source = isSource(key, group, sources)
    if ("visibleWhen" !in node && !source)
      return fail(at, "sharedKey requires visibleWhen on the same node")
    val resolvedKeys = keys(context, located, key, at, group != null)
    resolvedKeys.error?.let {
      return it
    }
    glassKeyError(resolvedKeys.values, group, at, pairs, glassKeys)?.let {
      return it
    }
    if (source) return null
    val occurrence =
      Occurrence(
        path,
        at,
        boundary(context, path),
        shared?.text("as") ?: "bounds",
        '{' in key,
        resolvedKeys.repeatPath,
      )
    for (resolved in resolvedKeys.values) {
      val prior = pairs.getOrPut(resolved) { mutableListOf() }
      pairError(resolved, occurrence, prior, pairs.size)?.let {
        return it
      }
      prior.add(occurrence)
    }
    return null
  }

  private fun isSource(key: String, group: String?, sources: Set<String>): Boolean =
    group != null || key in sources

  private fun glassKeyError(
    keys: List<String>,
    group: String?,
    at: String,
    pairs: Map<String, List<Occurrence>>,
    glassKeys: MutableMap<String, MutableSet<String>>,
  ): PrototypeSpecError? {
    for (resolved in keys) {
      val scopes = glassKeys[resolved]
      val collision = if (group != null) resolved in pairs else scopes != null
      if (collision)
        return fail(at, "glass shared key \"$resolved\" cannot also be used by a visibility pair")
      if (group != null) {
        if (scopes?.contains(group) == true)
          return fail(at, "shared key \"$resolved\" must be unique within its glassGroup")
        glassKeys.getOrPut(resolved) { mutableSetOf() }.add(group)
      }
    }
    return null
  }

  private data class Keys(
    val values: List<String> = emptyList(),
    val error: PrototypeSpecError? = null,
    val repeatPath: String? = null,
  )

  private fun keys(
    context: PrototypeStateChecks.Context,
    located: PrototypeStateChecks.Located,
    key: String,
    at: String,
    glass: Boolean,
  ): Keys {
    val path = located.path
    val shared = "shared" in located.value
    val parent =
      context.nodes.lastOrNull { (ancestor, ancestorPath) ->
        "repeat" in ancestor && (path == ancestorPath || path.startsWith("$ancestorPath."))
      }
    val repeat = parent?.value?.get("repeat") as? JsonObject
    val scope = parent?.let {
      PrototypeRepeatTree.scopeOf(
        it.value,
        it.path,
        PrototypeRepeatData((context.root as? JsonObject)?.get("data") as? JsonObject),
      )
    }
    val templateError = templateError(key, shared, glass || path != parent?.path, repeat, at)
    if (templateError != null) return Keys(error = templateError)
    val keys =
      if (scope != null && '{' in key)
        scope.items.mapIndexed { index, item ->
          PrototypeRepeatTemplate.bind(key, scope.alias, item, index)
        }
      else listOf(key)
    if (keys.any { !validKey(it) } && shared)
      return Keys(
        error =
          fail(
            at,
            if ('{' in key) "Invalid resolved shared key value" else "Invalid shared key value",
          ),
      )
    if (keys.toSet().size != keys.size)
      return Keys(error = fail(at, "shared key resolves to multiple nodes on the same side"))
    return Keys(keys, repeatPath = parent?.path?.takeUnless { it == path })
  }

  private fun templateError(
    key: String,
    shared: Boolean,
    templateRequired: Boolean,
    repeat: JsonObject?,
    at: String,
  ): PrototypeSpecError? {
    if (!shared && repeat != null)
      return fail(at, "sharedKey is not allowed inside repeat templates")
    if ('{' !in key)
      return if (repeat != null && templateRequired)
        fail(at, "shared key inside repeat requires a key template")
      else null
    val field = repeat?.text("key")
    if (field == null || !templateRequired)
      return fail(at, "shared key template requires repeat.key")
    val segments = PrototypeRepeatTemplate.segments(key, repeat.text("as") ?: "")
    val fields = segments.filterIsInstance<PrototypeRepeatSegment.Field>()
    val valid = segments.all { matchesField(it, field) }
    if (fields.isEmpty() || !valid)
      return fail(at, "shared key template must reference only repeat.key")
    return null
  }

  private fun matchesField(segment: PrototypeRepeatSegment, field: String): Boolean =
    when (segment) {
      is PrototypeRepeatSegment.Index -> false
      is PrototypeRepeatSegment.Field -> segment.name == field
      is PrototypeRepeatSegment.Literal -> '{' !in segment.text && '}' !in segment.text
    }

  private fun validKey(key: String): Boolean = key.matches(Regex("^[A-Za-z_][A-Za-z0-9_-]{0,63}$"))

  private fun boundary(context: PrototypeStateChecks.Context, path: String): String =
    context.nodes
      .filter { (node, ancestor) ->
        node.text("type") in setOf("dialog", "bottomSheet") &&
          (path == ancestor || path.startsWith("$ancestor."))
      }
      .joinToString("/") { it.path }

  private fun pairError(
    key: String,
    entry: Occurrence,
    prior: List<Occurrence>,
    count: Int,
  ): PrototypeSpecError? =
    when {
      count > 16 -> fail(entry.at, "a spec allows at most 16 sharedKey values")
      entry.repeatPath != null && prior.any { it.repeatPath == entry.repeatPath } ->
        fail(entry.at, "shared key resolves to multiple nodes on the same side")
      prior.size == 2 -> fail(entry.at, pairMessage(key))
      prior.any { entry.path.startsWith("${it.path}.") } ->
        fail(entry.at, "sharedKey nodes cannot be nested in each other")
      prior.any { entry.boundary != it.boundary } ->
        fail(entry.at, "shared pair cannot cross a dialog or bottomSheet boundary")
      prior.any { entry.kind != it.kind } ->
        fail(entry.at, "shared pair must use the same as value")
      else -> null
    }

  private fun pairMessage(key: String): String =
    "sharedKey \"$key\" must be used by exactly two nodes"
}
