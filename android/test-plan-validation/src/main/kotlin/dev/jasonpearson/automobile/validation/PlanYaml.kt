package dev.jasonpearson.automobile.validation

import java.math.BigInteger
import java.util.regex.Pattern
import org.yaml.snakeyaml.DumperOptions
import org.yaml.snakeyaml.LoaderOptions
import org.yaml.snakeyaml.Yaml
import org.yaml.snakeyaml.constructor.AbstractConstruct
import org.yaml.snakeyaml.constructor.SafeConstructor
import org.yaml.snakeyaml.nodes.Node
import org.yaml.snakeyaml.nodes.ScalarNode
import org.yaml.snakeyaml.nodes.Tag
import org.yaml.snakeyaml.representer.Representer
import org.yaml.snakeyaml.resolver.Resolver

/**
 * Builds the YAML loader the plan validator parses with, typing plain scalars the way the daemon's
 * js-yaml `CORE_SCHEMA` does (`src/utils/plan/planYaml.ts`, #10129). SnakeYAML's default resolver
 * is YAML 1.1: it turns an unquoted ISO timestamp into a `Date` and `yes`/`no`/`on`/`off` into
 * booleans, so a plan the daemon accepts was rejected here. The shared table in
 * `test/fixtures/plan-yaml/core-schema-scalars.json` pins both sides to the same results.
 */
internal object PlanYaml {
  /** A new loader per call: SnakeYAML's [Yaml] is not thread-safe. */
  fun newLoader(): Yaml {
    val loaderOptions = LoaderOptions()
    val dumperOptions = DumperOptions()
    return Yaml(
      PlanYamlConstructor(loaderOptions),
      Representer(dumperOptions),
      dumperOptions,
      loaderOptions,
      CoreSchemaResolver(),
    )
  }

  // js-yaml core schema forms. Anything that does not match stays a string. Named CORE_* because
  // the Resolver subclass below would otherwise resolve NULL/BOOL/INT/... to its inherited YAML 1.1
  // statics.
  private val CORE_NULL: Pattern = Pattern.compile("^(?:~|null|Null|NULL)$")
  private val CORE_EMPTY: Pattern = Pattern.compile("^$")
  private val CORE_BOOL: Pattern = Pattern.compile("^(?:true|True|TRUE|false|False|FALSE)$")
  private val CORE_INT: Pattern = Pattern.compile("^(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$")
  private val CORE_FLOAT: Pattern =
    Pattern.compile(
      "^(?:[-+]?(?:\\.[0-9]+|[0-9]+(?:\\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?" +
        "|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$"
    )

  private class CoreSchemaResolver : Resolver() {
    /** Replaces YAML 1.1's list wholesale: no timestamp, no yes/no/on/off, no sexagesimal. */
    override fun addImplicitResolvers() {
      addImplicitResolver(Tag.BOOL, CORE_BOOL, "tTfF")
      addImplicitResolver(Tag.INT, CORE_INT, "-+0123456789")
      addImplicitResolver(Tag.FLOAT, CORE_FLOAT, "-+0123456789.")
      addImplicitResolver(Tag.MERGE, Resolver.MERGE, "<")
      addImplicitResolver(Tag.NULL, CORE_NULL, "~nN\u0000")
      // A null first-character list matches any scalar, which is how SnakeYAML resolves "".
      addImplicitResolver(Tag.NULL, CORE_EMPTY, null)
    }
  }

  private class PlanYamlConstructor(options: LoaderOptions) : SafeConstructor(options) {
    init {
      yamlConstructors[Tag.INT] = CoreInt()
      yamlConstructors[Tag.FLOAT] = CoreFloat()
      // `<<` as a merge key is consumed by flattenMapping; as a plain value (`v: <<`) js-yaml
      // keeps the string, where SnakeYAML would fail with no constructor for the merge tag.
      yamlConstructors[Tag.MERGE] = yamlConstructors.getValue(Tag.STR)
    }
  }

  /** Decimal (leading zeros stay decimal, as in js-yaml), `0o` octal and `0x` hex. */
  private class CoreInt : AbstractConstruct() {
    override fun construct(node: Node): Any {
      val text = (node as ScalarNode).value
      val unsigned = text.trimStart('-', '+')
      val negative = text.startsWith("-")
      val magnitude =
        when {
          unsigned.startsWith("0o") -> BigInteger(unsigned.substring(2), 8)
          unsigned.startsWith("0x") -> BigInteger(unsigned.substring(2), 16)
          else -> BigInteger(unsigned)
        }
      val value = if (negative) magnitude.negate() else magnitude
      return when {
        value.bitLength() < Int.SIZE_BITS -> value.toInt()
        value.bitLength() < Long.SIZE_BITS -> value.toLong()
        else -> value
      }
    }
  }

  private class CoreFloat : AbstractConstruct() {
    override fun construct(node: Node): Any {
      val text = (node as ScalarNode).value
      val negative = text.startsWith("-")
      val unsigned = text.trimStart('-', '+')
      return when (unsigned.lowercase()) {
        ".inf" -> if (negative) Double.NEGATIVE_INFINITY else Double.POSITIVE_INFINITY
        ".nan" -> Double.NaN
        else -> text.toDouble()
      }
    }
  }
}
