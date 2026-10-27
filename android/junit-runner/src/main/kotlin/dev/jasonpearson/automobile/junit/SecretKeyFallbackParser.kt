package dev.jasonpearson.automobile.junit

/** Placeholder-tolerant fallback for documents SnakeYAML cannot load. */
internal object SecretKeyFallbackParser {
  fun parse(planContent: String): Set<String> {
    val lines = planContent.split('\n')
    val keys = LinkedHashSet<String>()
    var index = 0
    while (index < lines.size) {
      val trimmed = stripComments(lines[index]).trim()
      if (
        indentationLevel(stripComments(lines[index])) != 0 ||
          !trimmed.startsWith("secretParameters:")
      ) {
        index++
        continue
      }
      // Peek at the value with a quote-aware comment strip (a `#` inside a quoted key is literal
      // YAML, not a comment): empty -> block sequence, `[` -> flow sequence, else bare scalar.
      // `lines[index]` is the raw line and begins with the key (indent 0).
      val rawValue = lines[index].removePrefix("secretParameters:")
      val inline = SecretKeyScalars.stripFlowComment(rawValue).trim()
      if (inline.isNotEmpty()) {
        if (inline.startsWith("[")) {
          // A flow value may span multiple physical lines; a single-pass scanner handles the
          // multiline form, quoted `#`, escaped quotes, trailing comments after `]`, and line
          // folding — and fails safe toward over-capture (#6097).
          val (flowKeys, nextIndex) = SecretFlowScanner().parse(lines, index, rawValue)
          keys.addAll(flowKeys)
          index = nextIndex
          continue
        }
        // Bare inline scalar (no brackets): treat as a single key name.
        keys.addAll(SecretKeyScalars.parseInlineList(inline))
        index++
        continue
      }
      index++
      // Block sequence: `-` items at ANY indent (flush with the parent key is valid YAML) until the
      // next non-list line, i.e. the next top-level key.
      index = parseBlock(lines, index, keys)
    }
    return keys
  }

  private fun parseBlock(lines: List<String>, start: Int, keys: MutableSet<String>): Int {
    var index = start
    while (index < lines.size) {
      val itemTrimmed = stripComments(lines[index]).trim()
      if (itemTrimmed.isEmpty()) {
        index++
        continue
      }
      if (!itemTrimmed.startsWith("-")) break
      val item = SecretKeyScalars.unquote(itemTrimmed.removePrefix("-").trim())
      if (item.isNotEmpty()) keys.add(item)
      index++
    }
    return index
  }

  private fun stripComments(line: String): String {
    val hash = line.indexOf('#')
    return if (hash >= 0) line.substring(0, hash) else line
  }

  private fun indentationLevel(line: String): Int = line.takeWhile { it == ' ' }.length
}
