package dev.jasonpearson.automobile.protocol

import java.util.Locale
import kotlinx.serialization.json.*

/** The only resolution failure is a typed platform invalid_args outcome, before any UI. */
data class PrototypeShareError(val path: String, val message: String) {
  val code: String = "invalid_args"
}

sealed interface PrototypeShareResolution {
  data class Resolved(val payload: JsonObject, val summary: JsonObject) : PrototypeShareResolution

  data class Failure(val error: PrototypeShareError) : PrototypeShareResolution

  fun toJson(): JsonObject =
    when (this) {
      is Resolved ->
        buildJsonObject {
          put("ok", true)
          put("payload", payload)
          put("summary", summary)
        }
      is Failure ->
        buildJsonObject {
          put("ok", false)
          putJsonObject("error") {
            put("code", error.code)
            put("path", error.path)
            put("message", error.message)
          }
        }
    }
}

/** Pure share contract; intentionally does not register a system-sheet driver. */
object PrototypeShare {
  val MAX_PROTOTYPE_SHARE_TEXT_BYTES = limit("MAX_PROTOTYPE_SHARE_TEXT_BYTES")
  val MAX_PROTOTYPE_SHARE_IMAGES = limit("MAX_PROTOTYPE_SHARE_IMAGES")
  val MAX_PROTOTYPE_SHARE_FILES = limit("MAX_PROTOTYPE_SHARE_FILES")

  private fun limit(key: String) = PrototypeSpecContract.limits.getValue(key).jsonPrimitive.int

  private val names = setOf("contact", "files", "images", "subject", "text", "url")
  private val contactNames = setOf("email", "name", "note", "org", "phone", "url")
  private val mime = Regex("[!#$%&'*+.^_`|~0-9A-Za-z-]+/[!#$%&'*+.^_`|~0-9A-Za-z-]+")
  private val tokens = Regex("\\{([^{}]*)\\}")

  private fun text(value: JsonElement?) = (value as? JsonPrimitive)?.takeIf { it.isString }?.content

  private fun bytes(value: String) = value.toByteArray(Charsets.UTF_8).size

  private fun error(path: String, message: String) = PrototypeSpecError(path, message)

  private fun member(path: String, key: String) = PrototypeValidationPaths.keyPath(path, key)

  private fun validURL(value: String, dynamic: Boolean = false): Boolean {
    val start =
      when {
        value.take(8).lowercase(Locale.ROOT) == "https://" -> 8
        value.take(7).lowercase(Locale.ROOT) == "http://" -> 7
        else -> return false
      }
    if (
      value.any {
        it.code <= 32 ||
          it.code in 127..160 ||
          it.code in 0x2028..0x202e ||
          it.code in 0x2066..0x2069 ||
          it == '\\'
      }
    )
      return false
    val candidate = if (dynamic) maskTemplate(value, "1") else value
    val authority = candidate.substring(start).takeWhile { it !in "/?#" }
    if (authority.isEmpty() || authority.any { it in "@{}<>^|%" }) return false
    val port: String?
    if (authority.startsWith("[")) {
      val end = authority.indexOf(']')
      if (end < 0) return false
      val halves = authority.substring(1, end).split("::")
      val groups = halves.flatMap { if (it.isEmpty()) emptyList() else it.split(':') }
      if (
        halves.size > 2 ||
          groups.any {
            it.length !in 1..4 || it.any { char -> char !in "0123456789abcdefABCDEF" }
          } ||
          (if (halves.size == 1) groups.size != 8 else groups.size >= 8)
      )
        return false
      val tail = authority.substring(end + 1)
      if (tail.isNotEmpty() && !tail.startsWith(":")) return false
      port = if (tail.isEmpty()) null else tail.substring(1)
    } else {
      val parts = authority.split(':')
      if (parts.size > 2 || parts[0].isEmpty() || parts[0].any { it in "[]" }) return false
      port = parts.getOrNull(1)
    }
    return port.isNullOrEmpty() ||
      (port.length in 1..5 && port.all { it in '0'..'9' } && port.toInt() <= 65535)
  }

  private fun textError(value: JsonElement?, path: String): PrototypeSpecError? {
    val text = text(value) ?: return error(path, "Expected share string")
    return if (bytes(text) > MAX_PROTOTYPE_SHARE_TEXT_BYTES)
      error(path, "Share string exceeds 65536 UTF-8 bytes")
    else null
  }

  private fun assetId(value: JsonElement?): String? =
    text(value) ?: (value as? JsonObject)?.takeIf { it.size == 1 }?.get("asset")?.let(::text)

  private fun assetError(
    value: JsonElement?,
    path: String,
    dynamic: Boolean,
    assets: Set<String>?,
  ): PrototypeSpecError? {
    val form = value as? JsonObject
    if (
      dynamic && form?.size == 1 && text(form["data"])?.let(PrototypeDataPointer::isValid) == true
    )
      return null
    val id = assetId(value)
    if (id.isNullOrEmpty() || id.any { it in "{}" })
      return error(path, "Expected uploaded asset id or data binding")
    return if (assets != null && id !in assets) error(path, "Unknown share asset") else null
  }

  private fun maskTemplate(text: String, replacement: String = "x"): String =
    tokens.replace(text) { match ->
      val token = match.groupValues[1]
      if (
        PrototypeSpecContract.stateKeyPattern.matches(token) ||
          (token.split('.').let {
            it.size == 2 && it.all(PrototypeSpecContract.stateKeyPattern::matches)
          }) ||
          (token.startsWith("data:") && PrototypeDataPointer.isValid(token.substring(5)))
      )
        replacement
      else match.value
    }

  private fun valueError(
    name: String,
    value: JsonElement?,
    path: String,
    dynamic: Boolean,
    assets: Set<String>?,
  ): PrototypeSpecError? {
    if (name in setOf("text", "subject", "url")) {
      textError(value, path)?.let {
        return it
      }
      return if (name == "url" && text(value) != "" && !validURL(text(value)!!, dynamic))
        error(path, "Share URL must be absolute http(s) with a literal scheme")
      else null
    }
    if (name == "contact") {
      val form = value as? JsonObject ?: return error(path, "Expected share contact object")
      for (key in (form.keys + "name").sorted()) {
        val at = member(path, key)
        if (key !in contactNames) return error(at, "Unknown contact field")
        if (key !in form) return error(at, "Required contact name")
        textError(form[key], at)?.let {
          return it
        }
        if (key == "name" && PrototypeSpecContract.blankTextPattern.matches(text(form[key])!!))
          return error(at, "Required contact name")
        if (key == "url" && !validURL(text(form[key])!!, dynamic))
          return error(at, "Share URL must be absolute http(s) with a literal scheme")
      }
      return null
    }
    val array = value as? JsonArray ?: return error(path, "Expected share array")
    val max = if (name == "images") MAX_PROTOTYPE_SHARE_IMAGES else MAX_PROTOTYPE_SHARE_FILES
    if (array.size !in 1..max) return error(path, "Share $name must contain 1 to $max items")
    for ((index, entry) in array.withIndex()) {
      val at = "$path[$index]"
      if (name == "images") {
        assetError(entry, at, dynamic, assets)?.let {
          return it
        }
        continue
      }
      val file = entry as? JsonObject ?: return error(at, "Expected share file object")
      for (key in (file.keys + setOf("asset", "mimeType", "name")).sorted()) {
        val field = member(at, key)
        if (key !in setOf("asset", "mimeType", "name")) return error(field, "Unknown file field")
        when (key) {
          "asset" ->
            assetError(file[key], field, false, assets)?.let {
              return it
            }
          "mimeType" ->
            if (
              !(dynamic && text(file[key])?.let { maskTemplate(it) != it } == true) &&
                text(file[key])?.let(mime::matches) != true
            )
              return error(field, "Share mimeType must be a type/subtype token")
          else -> {
            val nameText = text(file[key])?.let { if (dynamic) maskTemplate(it) else it }
            if (
              nameText.isNullOrEmpty() ||
                nameText.startsWith(".") ||
                nameText.any {
                  it == '/' ||
                    it == '\\' ||
                    it.code <= 31 ||
                    it.code in 127..160 ||
                    it.code in 0x2028..0x202e ||
                    it.code in 0x2066..0x2069
                } ||
                bytes(nameText) > 128
            )
              return error(
                field,
                "Share file name must be 1 to 128 UTF-8 bytes, with no leading dot, separators or controls",
              )
          }
        }
      }
    }
    return null
  }

  fun argumentsError(
    args: JsonObject,
    path: String,
    assets: Set<String>? = null,
    resolved: Boolean = false,
  ): PrototypeSpecError? {
    for (name in args.keys.sorted()) {
      val at = member(path, name)
      if (name !in names)
        return error(
          at,
          if (name == "title") "Unknown argument: use subject" else "Unknown argument",
        )
      val binding = args[name] as? JsonObject
      if (!resolved && binding?.containsKey("value") != true) continue
      valueError(
          name,
          if (resolved) args[name] else binding?.get("value"),
          if (resolved) at else "$at.value",
          !resolved,
          assets,
        )
        ?.let {
          return it
        }
    }
    if (
      setOf("text", "url", "images", "files", "contact").none { name ->
        if (name !in args) false
        else {
          val binding = args[name] as? JsonObject
          if (!resolved && binding?.containsKey("value") != true) true
          else {
            val value = if (resolved) args[name] else binding?.get("value")
            text(value)?.let { !PrototypeSpecContract.blankTextPattern.matches(it) } ?: true
          }
        }
      }
    )
      return error(path, "Share requires text, url, images, files or contact")
    return null
  }

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
    val name = escape(text(contact["name"])!!)
    val lines = mutableListOf("BEGIN:VCARD", "VERSION:3.0", "FN:$name", "N:$name;;;;")
    for ((field, label) in
      listOf(
        "phone" to "TEL",
        "email" to "EMAIL",
        "org" to "ORG",
        "url" to "URL",
        "note" to "NOTE",
      )) {
      text(contact[field])?.let { lines.add("$label:${if (field == "url") it else escape(it)}") }
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
    argumentsError(args, "args")?.let {
      return failure(it)
    }
    val resolved = linkedMapOf<String, JsonElement>()
    for (name in args.keys.sorted()) {
      val binding = args[name] as? JsonObject ?: JsonObject(emptyMap())
      var value =
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
        } ?: return failure(error("args.$name", "Share binding is missing"))
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
    argumentsError(JsonObject(resolved), "args", assets.keys, true)?.let {
      return failure(it)
    }
    for (name in listOf("images", "files")) {
      for ((index, entry) in (resolved[name] as? JsonArray).orEmpty().withIndex()) {
        val id = assetId(if (name == "files") entry.jsonObject["asset"] else entry)!!
        val size =
          ((assets[id] as? JsonObject)?.get("bytes") as? JsonPrimitive)
            ?.takeUnless { it.isString }
            ?.doubleOrNull
        if (
          size == null ||
            !size.isFinite() ||
            size < 0 ||
            size > 9007199254740991.0 ||
            size != Math.floor(size)
        )
          return failure(
            error(
              "args.$name[$index]" + if (name == "files") ".asset" else "",
              "Share asset must have non-negative integer bytes",
            ),
          )
      }
    }
    val images = (resolved["images"] as? JsonArray).orEmpty().map { JsonPrimitive(assetId(it)!!) }
    val files =
      (resolved["files"] as? JsonArray).orEmpty().map { entry ->
        val file = entry.jsonObject
        val id = assetId(file["asset"])!!
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
}
