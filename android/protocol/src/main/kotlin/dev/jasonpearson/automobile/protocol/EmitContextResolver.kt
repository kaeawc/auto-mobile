package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.*

/** Strict binding shape is enforced by the shared contract before decoding. */
typealias EmitContextBinding = JsonObject

/** Lookups are performed at the emit action, after preceding writes in the atomic action list. */
interface EmitContextInputs {
  fun state(key: String): JsonElement?

  fun page(id: String): Int?

  fun data(pointer: String): JsonElement?
}

data class ResolvedEmitContext(val context: JsonObject, val contextTruncated: Boolean? = null)

/** Pure JVM resolver; ordered maps retain arbitrary names, including __proto__. */
object EmitContextResolver {
  fun resolve(
    bindings: Map<String, EmitContextBinding>,
    inputs: EmitContextInputs,
  ): ResolvedEmitContext {
    val entries = bindings.map { (name, binding) ->
      val value =
        when {
          "state" in binding -> inputs.state(binding.getValue("state").jsonPrimitive.content)
          "page" in binding ->
            inputs.page(binding.getValue("page").jsonPrimitive.content)?.let(::JsonPrimitive)
          "data" in binding -> inputs.data(binding.getValue("data").jsonPrimitive.content)
          else -> binding["value"]
        }
      name to (value ?: JsonNull)
    }
    val complete = JsonObject(entries.toMap(LinkedHashMap()))
    if (fits(complete)) return ResolvedEmitContext(complete)
    val prefix = linkedMapOf<String, JsonElement>()
    for ((name, value) in
      entries.sortedWith { left, right -> compareNames(left.first, right.first) }) {
      prefix[name] = value
      if (!fits(JsonObject(prefix))) {
        prefix.remove(name)
        break
      }
    }
    return ResolvedEmitContext(JsonObject(prefix), true)
  }

  /** Reuse the scalar serializer and repeat renderer's integral number spelling. */
  fun scalar(value: PrototypeScalar): JsonElement {
    val encoded = Json.encodeToJsonElement(PrototypeScalar.serializer(), value)
    return if (value is PrototypeScalar.Numeric)
      Json.parseToJsonElement(PrototypeRepeatTemplate.rendered(encoded.jsonPrimitive))
    else encoded
  }

  /** Unsigned UTF-8 bytes, independent of UTF-16 String ordering. */
  private fun compareNames(left: String, right: String): Int {
    val a = left.toByteArray(Charsets.UTF_8)
    val b = right.toByteArray(Charsets.UTF_8)
    for (index in 0 until minOf(a.size, b.size)) {
      val difference = (a[index].toInt() and 0xff) - (b[index].toInt() and 0xff)
      if (difference != 0) return difference
    }
    return a.size - b.size
  }

  private fun fits(context: JsonObject): Boolean =
    context.toString().toByteArray(Charsets.UTF_8).size <=
      PrototypeSpecValidator.MAX_PROTOTYPE_EMIT_PAYLOAD_BYTES
}
