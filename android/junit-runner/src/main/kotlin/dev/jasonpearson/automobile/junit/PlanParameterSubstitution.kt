package dev.jasonpearson.automobile.junit

import java.io.StringReader
import java.io.StringWriter
import java.util.IdentityHashMap
import org.yaml.snakeyaml.DumperOptions
import org.yaml.snakeyaml.DumperOptions.ScalarStyle
import org.yaml.snakeyaml.LoaderOptions
import org.yaml.snakeyaml.Yaml
import org.yaml.snakeyaml.constructor.SafeConstructor
import org.yaml.snakeyaml.emitter.Emitter
import org.yaml.snakeyaml.nodes.MappingNode
import org.yaml.snakeyaml.nodes.Node
import org.yaml.snakeyaml.nodes.NodeId
import org.yaml.snakeyaml.nodes.NodeTuple
import org.yaml.snakeyaml.nodes.ScalarNode
import org.yaml.snakeyaml.nodes.SequenceNode
import org.yaml.snakeyaml.nodes.Tag
import org.yaml.snakeyaml.resolver.Resolver
import org.yaml.snakeyaml.serializer.Serializer

/**
 * Applies `${name}` plan parameters to a plan AFTER it is parsed, on the YAML node tree's scalars
 * (issue #10093), so a parameter value can never be re-interpreted by the YAML parser: a backslash,
 * quote, ` #`, `: ` or line break in the value arrives exactly as supplied and cannot change the
 * plan's structure.
 *
 * Mechanism: every known `${name}` in the source is first swapped for an inert alphanumeric
 * sentinel, the document is composed into a node graph, each scalar's text is then rewritten in ONE
 * pass (sentinel -> value; the inserted text is never rescanned, so a value containing `${other}`
 * is not expanded again), and the graph is serialized back to YAML for the daemon. The sentinel
 * pre-pass keeps placeholders legal in positions where the raw `${...}` is not valid YAML (a plain
 * scalar inside a flow collection).
 *
 * Typing rules (kept identical to the old text-splice behaviour for values that used to work):
 * - An UNQUOTED scalar that is exactly one placeholder (`text: ${n}`) takes the value's text read
 *   by YAML plain-scalar rules, so `Int`/`Boolean`/`Double` parameters — and the strings `"500"`,
 *   `"true"` — stay a number/boolean/null for numeric and boolean tool arguments, as before. A
 *   value that is not a plain-safe scalar (`shoes #1`, `size: large`, leading space, line break)
 *   cannot be one, so it becomes a string.
 * - A QUOTED or block scalar, or a placeholder embedded in longer text (`"Hi ${name}"`), is always
 *   a string. Write `text: "${apiToken}"` (the documented form) to type a digits-only token as
 *   text.
 */
internal object PlanParameterSubstitution {
  private val resolver = Resolver()

  /**
   * Single-pass substitution of known `${name}` placeholders in a plain string (no YAML involved).
   * Unknown placeholders stay literal. Substituted text is never rescanned.
   */
  fun substituteText(content: String, parameters: Map<String, Any>): String {
    val pattern = placeholderPattern(parameters) ?: return content
    return pattern.replace(content) { match ->
      parameterText(parameters.getValue(match.groupValues[1]))
    }
  }

  /**
   * Substitute parameters into a plan's YAML [planContent] on the parsed tree and return the plan
   * YAML to send onward. Returns [planContent] untouched when no known placeholder occurs or the
   * document cannot be composed (the schema validator then reports the YAML error against the
   * author's own text).
   */
  fun substitutePlan(planContent: String, parameters: Map<String, Any>): String {
    val pattern = placeholderPattern(parameters) ?: return planContent
    if (!pattern.containsMatchIn(planContent)) return planContent

    val sentinels = SentinelTable(freshPrefix(planContent))
    val tokenized = pattern.replace(planContent) { sentinels.register(it.groupValues[1]) }

    val root =
      runCatching { newYaml().compose(StringReader(tokenized)) }.getOrNull() ?: return planContent
    val rewriter = TreeRewriter(sentinels, parameters)
    return serialize(rewriter.rewrite(root))
  }

  private fun placeholderPattern(parameters: Map<String, Any>): Regex? {
    if (parameters.isEmpty()) return null
    val names =
      parameters.keys
        .sortedByDescending { it.length }
        .joinToString("|") {
          Regex.escape(it)
        }
    return Regex("""\$\{($names)}""")
  }

  private fun parameterText(value: Any): String = SecretRedactor.parameterStringValue(value)

  // A prefix absent from the source, so a sentinel can never collide with real plan text.
  private fun freshPrefix(source: String): String {
    var prefix = "AMxPARAMx"
    while (source.contains(prefix)) prefix += "x"
    return prefix
  }

  // SafeConstructor: compose never builds Java objects anyway; this just keeps the parser the same
  // hardened configuration the redactor uses.
  private fun newYaml(): Yaml = Yaml(SafeConstructor(LoaderOptions()))

  private fun serialize(root: Node): String {
    val options =
      DumperOptions().apply {
        splitLines = false
        isAllowUnicode = true
        indent = 2
        width = Int.MAX_VALUE
      }
    val writer = StringWriter()
    val serializer = Serializer(Emitter(writer, options), resolver, options, null)
    serializer.open()
    serializer.serialize(root)
    serializer.close()
    return writer.toString()
  }

  /** Index <-> original-parameter-name table for the sentinels swapped into the source. */
  private class SentinelTable(private val prefix: String) {
    private val names = mutableListOf<String>()
    val pattern = Regex("${Regex.escape(prefix)}(\\d+)x")

    fun register(name: String): String {
      names.add(name)
      return "$prefix${names.size - 1}x"
    }

    fun nameAt(index: Int): String = names[index]
  }

  /** Rewrites sentinels in every scalar (keys and values) of a composed node graph. */
  private class TreeRewriter(
    private val sentinels: SentinelTable,
    private val parameters: Map<String, Any>,
  ) {
    private val seen = IdentityHashMap<Node, Node>()

    fun rewrite(node: Node): Node {
      seen[node]?.let {
        return it
      }
      val rewritten =
        when (node.nodeId) {
          NodeId.scalar -> rewriteScalar(node as ScalarNode)
          NodeId.sequence -> node.also { rewriteSequence(it as SequenceNode) }
          NodeId.mapping -> node.also { rewriteMapping(it as MappingNode) }
          else -> node
        }
      seen[node] = rewritten
      return rewritten
    }

    private fun rewriteSequence(node: SequenceNode) {
      seen[node] = node
      val items = node.value
      for (index in items.indices) items[index] = rewrite(items[index])
    }

    private fun rewriteMapping(node: MappingNode) {
      seen[node] = node
      node.value = node.value.map { NodeTuple(rewrite(it.keyNode), rewrite(it.valueNode)) }
    }

    private fun rewriteScalar(node: ScalarNode): Node {
      val text = node.value
      if (!sentinels.pattern.containsMatchIn(text)) return node

      val whole = sentinels.pattern.matchEntire(text)
      if (whole != null && node.scalarStyle == ScalarStyle.PLAIN) {
        val value = parameterText(parameters.getValue(sentinels.nameAt(index(whole))))
        return typedPlain(node, value)
      }
      val replaced =
        sentinels.pattern.replace(text) {
          parameterText(parameters.getValue(sentinels.nameAt(index(it))))
        }
      return quoted(node, replaced)
    }

    private fun index(match: MatchResult): Int = match.groupValues[1].toInt()

    // Plain scalar that is exactly one placeholder: YAML plain-scalar typing, as the text splice
    // did.
    private fun typedPlain(node: ScalarNode, value: String): Node {
      val tag = resolver.resolve(NodeId.scalar, value, true)
      // An empty value would resolve to YAML null. The iOS runner writes `""`, so both runners
      // treat an empty parameter as an empty string.
      if (tag == Tag.STR || value.isEmpty()) return quoted(node, value)
      return ScalarNode(tag, value, node.startMark, node.endMark, ScalarStyle.PLAIN)
    }

    // Always double-quoted: the emitter escapes `\`, `"` and control characters, and keeps a value
    // such as `12345` a string. A single, predictable style also keeps the serialized form of a
    // secret value stable for redaction.
    private fun quoted(node: ScalarNode, value: String): Node =
      ScalarNode(Tag.STR, value, node.startMark, node.endMark, ScalarStyle.DOUBLE_QUOTED)
  }
}
