package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text

/** Cross-node constraints in contract pre-order, after structural validation. */
internal object PrototypeSharedElementRules {
  fun error(context: PrototypeStateChecks.Context): PrototypeSpecError? {
    PrototypeStackPatternRules.error(context)?.let {
      return it
    }
    val sources = PrototypeStackPatternRules.sources(context)
    val repeats = mutableListOf<String>()
    val pairs = linkedMapOf<String, MutableList<String>>()
    for ((node, path) in context.nodes) {
      if ("repeat" in node) repeats.add(path)
      val key = node.text("sharedKey") ?: continue
      val at = "$path.sharedKey"
      if ("visibleWhen" !in node && key !in sources)
        return fail(at, "sharedKey requires visibleWhen on the same node")
      if (repeats.any { path == it || path.startsWith("$it.") })
        return fail(at, "sharedKey is not allowed inside repeat templates")
      val prior = pairs.getOrPut(key) { mutableListOf() }
      if (pairs.size > 16) return fail(at, "a spec allows at most 16 sharedKey values")
      if (prior.size == 2) return fail(at, pairMessage(key))
      if (prior.any { path.startsWith("$it.") })
        return fail(at, "sharedKey nodes cannot be nested in each other")
      prior.add(path)
    }
    return unpaired(pairs, sources)
  }

  private fun unpaired(
    pairs: Map<String, List<String>>,
    sources: Set<String>,
  ): PrototypeSpecError? {
    for ((key, paths) in pairs) {
      if (paths.size != 2 && key !in sources)
        return fail("${paths.first()}.sharedKey", pairMessage(key))
    }
    return null
  }

  private fun pairMessage(key: String): String =
    "sharedKey \"$key\" must be used by exactly two nodes"
}
