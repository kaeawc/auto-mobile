package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeShareValues.assetId
import dev.jasonpearson.automobile.protocol.PrototypeShareValues.bytes
import dev.jasonpearson.automobile.protocol.PrototypeShareValues.error
import dev.jasonpearson.automobile.protocol.PrototypeShareValues.text
import kotlinx.serialization.json.*

internal object PrototypeShareResolver {
  private val tokens = Regex("\\{([^{}]*)\\}")

  private fun scalar(value: JsonElement?): String? {
    val primitive = value as? JsonPrimitive ?: return null
    if (primitive is JsonNull) return null
    if (primitive.isString || primitive.booleanOrNull != null) return primitive.content
    val number = primitive.doubleOrNull ?: return null
    return if (number.isFinite() && number == Math.floor(number))
      PrototypeRepeatTemplate.rendered(primitive)
    else PrototypeRequests.numberText(number)
  }

  private fun bindText(value: String, inputs: JsonObject): String =
    tokens.replace(value) { match ->
      val token = match.groupValues[1]
      val data = inputs["data"] as? JsonObject
      val state = inputs["state"] as? JsonObject
      val item = inputs["item"] as? JsonObject
      when {
        token.startsWith("data:") && PrototypeDataPointer.isValid(token.substring(5)) ->
          scalar(PrototypeDataPointer.resolve(data, token.substring(5))) ?: ""
        token == "index" -> scalar(inputs["index"]) ?: match.value
        token.startsWith("item.") &&
          PrototypeSpecContract.stateKeyPattern.matches(token.substring(5)) ->
          scalar(item?.get(token.substring(5))) ?: match.value
        PrototypeSpecContract.stateKeyPattern.matches(token) ->
          scalar(state?.get(token)) ?: match.value
        else -> match.value
      }
    }

  private fun bindStrings(value: JsonElement, inputs: JsonObject): JsonElement =
    when (value) {
      is JsonObject -> JsonObject(value.mapValues { bindStrings(it.value, inputs) })
      is JsonArray -> JsonArray(value.map { bindStrings(it, inputs) })
      else -> text(value)?.let { JsonPrimitive(bindText(it, inputs)) } ?: value
    }

  private fun vCard(contact: JsonObject): String {
    fun escape(value: String) =
      value
        .replace("\\", "\\\\")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\n", "\\n")
        .replace(",", "\\,")
        .replace(";", "\\;")
    val name = escape(requireNotNull(text(contact["name"])))
    val lines = mutableListOf("BEGIN:VCARD", "VERSION:3.0", "FN:$name", "N:$name;;;;")
    for ((field, label) in
      listOf(
        "phone" to "TEL",
        "email" to "EMAIL",
        "org" to "ORG",
        "url" to "URL",
        "note" to "NOTE",
      )) {
      text(contact[field])?.let { lines.add("$label:${escape(it)}") }
    }
    lines.add("END:VCARD")
    return lines.joinToString("\r\n", postfix = "\r\n") { line ->
      buildString {
        var column = 0
        line.codePoints().forEach { point ->
          val char = String(Character.toChars(point))
          val size = bytes(char)
          if (column + size > 75) {
            append("\r\n ")
            column = 1
          }
          append(char)
          column += size
        }
      }
    }
  }

  /**
   * Inputs contain state/data/item/index, an uploaded assets map ({bytes}), and optional completion
   * outcome/target.
   */
  fun resolvePrototypeShare(args: JsonObject, inputs: JsonObject): PrototypeShareResolution {
    fun failure(error: PrototypeSpecError): PrototypeShareResolution =
      PrototypeShareResolution.Failure(PrototypeShareError(error.path, error.message))
    PrototypeShareValidation.argumentsError(args, "args")?.let {
      return failure(it)
    }
    val resolved = linkedMapOf<String, JsonElement>()
    for (name in args.keys.sorted()) {
      var value =
        resolveBinding(args[name] as? JsonObject ?: JsonObject(emptyMap()), inputs)
          ?: return failure(error("args.$name", "Share binding is missing"))
      value = bindStrings(value, inputs)
      if (name == "images" && value is JsonArray)
        value =
          JsonArray(
            value.map { entry ->
              val pointer = text((entry as? JsonObject)?.get("data"))
              if (pointer == null) entry
              else PrototypeDataPointer.resolve(inputs["data"] as? JsonObject, pointer) ?: JsonNull
            },
          )
      resolved[name] = value
    }
    val assets = inputs["assets"] as? JsonObject ?: JsonObject(emptyMap())
    PrototypeShareValidation.argumentsError(JsonObject(resolved), "args", assets.keys, true)?.let {
      return failure(it)
    }
    return result(resolved, assets, inputs)
  }

  private fun result(
    resolved: Map<String, JsonElement>,
    assets: JsonObject,
    inputs: JsonObject,
  ): PrototypeShareResolution {
    val images =
      (resolved["images"] as? JsonArray).orEmpty().map {
        JsonPrimitive(requireNotNull(assetId(it)))
      }
    val files =
      (resolved["files"] as? JsonArray).orEmpty().map { entry ->
        val file = entry.jsonObject
        val id = requireNotNull(assetId(file["asset"]))
        JsonObject(
          file +
            ("asset" to JsonPrimitive(id)) +
            ("bytes" to assets.getValue(id).jsonObject.getValue("bytes")),
        )
      }
    val payload =
      linkedMapOf<String, JsonElement>("images" to JsonArray(images), "files" to JsonArray(files))
    val items =
      linkedMapOf<String, JsonElement>(
        "images" to JsonPrimitive(images.size),
        "files" to JsonArray(files.map { JsonObject(it.filterKeys { key -> key != "asset" }) }),
        "contact" to JsonPrimitive("contact" in resolved),
      )
    for (name in listOf("text", "url", "subject")) text(resolved[name])?.let { value ->
      payload[name] = JsonPrimitive(value)
      items[name] =
        JsonPrimitive(
          if (name == "text")
            String(
              value.codePoints().limit(2048).toArray(),
              0,
              minOf(value.codePointCount(0, value.length), 2048),
            )
          else value,
        )
    }
    (resolved["contact"] as? JsonObject)?.let { payload["vCard"] = JsonPrimitive(vCard(it)) }
    val summary = buildJsonObject {
      put("outcome", inputs["outcome"] ?: JsonPrimitive("unknown"))
      inputs["target"]?.let { put("target", it) }
      put("items", JsonObject(items))
    }
    return PrototypeShareResolution.Resolved(JsonObject(payload), summary)
  }

  private fun resolveBinding(binding: JsonObject, inputs: JsonObject): JsonElement? =
    when {
      "value" in binding -> binding["value"]
      "state" in binding -> (inputs["state"] as? JsonObject)?.get(text(binding["state"]) ?: "")
      "data" in binding ->
        PrototypeDataPointer.resolve(inputs["data"] as? JsonObject, text(binding["data"]) ?: "")
      "item" in binding -> (inputs["item"] as? JsonObject)?.get(text(binding["item"]) ?: "")
      binding["index"] == JsonPrimitive(true) -> inputs["index"]
      "platform" in binding ->
        PrototypeDataPointer.resolve(
          inputs["platform"] as? JsonObject,
          text(binding["platform"]) ?: "",
        )
      "event" in binding ->
        PrototypeDataPointer.resolve(
          inputs["event"] as? JsonObject,
          text(binding["event"]) ?: "",
        )
      else -> null
    }
}
