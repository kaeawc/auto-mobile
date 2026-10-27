package dev.jasonpearson.automobile.junit

internal object SecretParameterMatcher {
  fun values(
    declaredKeys: Set<String>,
    parameters: Map<String, Any>,
  ): List<String> {
    if (declaredKeys.isEmpty()) return emptyList()
    val values = mutableListOf<String>()
    var hasUnresolvedKey = false
    for (key in declaredKeys) {
      val resolved = resolveKey(key, parameters)
      if (resolved == null) hasUnresolvedKey = true else values.addAll(resolved)
    }
    if (hasUnresolvedKey) {
      // A declared secret could not be located even leniently (e.g. a `\xNN` hex-escaped key the
      // scanner did not spec-decode). Over-redact every parameter value so it cannot leak (#6097).
      for (value in parameters.values) {
        SecretRedactor.parameterStringValue(value)
          .takeIf { it.isNotEmpty() }
          ?.let { values.add(it) }
      }
    }
    return values
  }

  private fun resolveKey(key: String, parameters: Map<String, Any>): List<String>? {
    // Escapes still present after parsing are low confidence; force over-redaction.
    if (key.contains('\\')) return null
    val exact =
      parameters[key]?.let { SecretRedactor.parameterStringValue(it) }?.takeIf { it.isNotEmpty() }
    if (exact != null) return listOf(exact)
    val target = normalizeKey(key)
    val matches = parameters.filterKeys { normalizeKey(it) == target }
    if (matches.isEmpty()) return null
    return matches.values.map { SecretRedactor.parameterStringValue(it) }.filter { it.isNotEmpty() }
  }

  /**
   * Case-folded key with backslashes, quotes, and whitespace/CR removed — the lenient key-identity
   * used to match a mis-encoded declared secret key to a parameter (#6097).
   */
  private fun normalizeKey(key: String): String = buildString {
    for (character in key.lowercase()) {
      when (character) {
        '\\',
        '"',
        '\'',
        ' ',
        '\t',
        '\r',
        '\n' -> Unit
        else -> append(character)
      }
    }
  }
}
