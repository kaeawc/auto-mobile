package dev.jasonpearson.automobile.validation

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

internal object TestPlanYaml {
  val yaml = run {
    // Retain SnakeYAML's default loader limits, sharing options with the safe constructor.
    val loaderOptions = LoaderOptions()
    val dumperOptions = DumperOptions()
    Yaml(
      PlanConstructor(loaderOptions),
      Representer(dumperOptions),
      dumperOptions,
      loaderOptions,
      PlanResolver(),
    )
  }

  /** Implicit scalar forms from js-yaml CORE_SCHEMA, plus the daemon's merge tag. */
  class PlanResolver : Resolver() {
    override fun addImplicitResolvers() {
      addImplicitResolver(
        Tag.BOOL,
        Pattern.compile("^(?:true|True|TRUE|false|False|FALSE)$"),
        "tTfF",
      )
      // Register integers before floats, whose core pattern also accepts decimal integers.
      addImplicitResolver(
        Tag.INT,
        Pattern.compile("^(?:0o[0-7]+|0x[0-9a-fA-F]+|[-+]?[0-9]+)$"),
        "-+0123456789",
      )
      addImplicitResolver(
        Tag.FLOAT,
        Pattern.compile(
          "^(?:[-+]?[0-9]+(?:\\.[0-9]*)?(?:[eE][-+]?[0-9]+)?|" +
            "[-+]?\\.[0-9]+(?:[eE][-+]?[0-9]+)?|" +
            "[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$",
        ),
        "-+0123456789.",
      )
      addImplicitResolver(Tag.NULL, NULL, "~nN\u0000")
      addImplicitResolver(Tag.NULL, EMPTY, null)
      addImplicitResolver(Tag.MERGE, MERGE, "<")
    }
  }

  /** SnakeYAML's integer constructor uses YAML 1.1 leading-zero octal semantics. */
  class PlanConstructor(loaderOptions: LoaderOptions) : SafeConstructor(loaderOptions) {
    init {
      val legacyInt = yamlConstructors.getValue(Tag.INT)
      yamlConstructors[Tag.INT] =
        object : AbstractConstruct() {
          override fun construct(node: Node): Any {
            val text = constructScalar(node as ScalarNode)
            val unsigned = text.removePrefix("-").removePrefix("+")
            val radix =
              when {
                unsigned.startsWith("0o") -> 8
                unsigned.startsWith("0x") -> 16
                unsigned.all { it in '0'..'9' } -> 10
                // Explicit legacy !!int tags retain SafeConstructor's existing handling.
                else -> return legacyInt.construct(node)
              }
            val digits = if (radix == 10) unsigned else unsigned.substring(2)
            val signed = if (text.startsWith("-")) "-$digits" else digits
            return createLongOrBigInteger(signed, radix)
          }
        }
    }
  }

  /** Convert a YAML-parsed object to kotlinx.serialization JsonElement */
  fun convertToJsonElement(obj: Any?): kotlinx.serialization.json.JsonElement {
    return when (obj) {
      null -> kotlinx.serialization.json.JsonNull
      is String -> kotlinx.serialization.json.JsonPrimitive(obj)
      is Number -> kotlinx.serialization.json.JsonPrimitive(obj)
      is Boolean -> kotlinx.serialization.json.JsonPrimitive(obj)
      is Map<*, *> -> {
        val map = obj.entries.associate { (k, v) -> k.toString() to convertToJsonElement(v) }
        kotlinx.serialization.json.JsonObject(map)
      }
      is List<*> -> {
        val list = obj.map { convertToJsonElement(it) }
        kotlinx.serialization.json.JsonArray(list)
      }
      else -> kotlinx.serialization.json.JsonPrimitive(obj.toString())
    }
  }
}
