package dev.jasonpearson.automobile.desktop.core.workspace

/**
 * Display labels keyed by stable id. Only duplicate names receive the shortest unique id suffix.
 */
internal fun <T> disambiguateLabels(
  items: List<T>,
  idOf: (T) -> String,
  nameOf: (T) -> String,
): Map<String, String> = buildMap {
  items.groupBy(nameOf).forEach { (name, group) ->
    if (group.size == 1) {
      put(idOf(group.single()), name)
    } else {
      val length = shortestDistinguishingLength(group.map(idOf))
      group.forEach { item ->
        val id = idOf(item)
        put(id, "$name (${id.takeLast(length)})")
      }
    }
  }
}

private fun shortestDistinguishingLength(ids: List<String>): Int {
  val maxLength = ids.maxOf { it.length }
  return (1..maxLength).firstOrNull { length ->
    ids.mapTo(mutableSetOf()) { it.takeLast(length) }.size == ids.size
  } ?: maxLength
}
