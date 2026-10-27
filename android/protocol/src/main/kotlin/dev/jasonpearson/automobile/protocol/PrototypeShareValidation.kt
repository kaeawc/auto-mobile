package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeShareValues.assetId
import dev.jasonpearson.automobile.protocol.PrototypeShareValues.bytes
import dev.jasonpearson.automobile.protocol.PrototypeShareValues.error
import dev.jasonpearson.automobile.protocol.PrototypeShareValues.maskTemplate
import dev.jasonpearson.automobile.protocol.PrototypeShareValues.member
import dev.jasonpearson.automobile.protocol.PrototypeShareValues.text
import kotlinx.serialization.json.*

internal object PrototypeShareValidation {
  private val names = setOf("contact", "files", "images", "subject", "text", "url")
  private val contactNames = setOf("email", "name", "note", "org", "phone", "url")
  private val mime = Regex("[!#$%&'*+.^_`|~0-9A-Za-z-]+/[!#$%&'*+.^_`|~0-9A-Za-z-]+")

  private fun textError(value: JsonElement?, path: String): PrototypeSpecError? {
    val text = text(value) ?: return error(path, "Expected share string")
    return if (bytes(text) > PrototypeShare.MAX_PROTOTYPE_SHARE_TEXT_BYTES)
      error(path, "Share string exceeds 65536 UTF-8 bytes")
    else null
  }

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

  private fun stringError(
    name: String,
    value: JsonElement?,
    path: String,
    dynamic: Boolean,
  ): PrototypeSpecError? {
    textError(value, path)?.let {
      return it
    }
    return if (
      name == "url" &&
        text(value) != "" &&
        !PrototypeShareURL.validURL(text(value).orEmpty(), dynamic)
    )
      error(path, "Share URL must be absolute http(s) with a literal scheme")
    else null
  }

  private fun contactError(
    value: JsonElement?,
    path: String,
    dynamic: Boolean,
  ): PrototypeSpecError? {
    val form = value as? JsonObject ?: return error(path, "Expected share contact object")
    for (key in (form.keys + "name").sorted()) {
      val at = member(path, key)
      if (key !in contactNames) return error(at, "Unknown contact field")
      if (key !in form) return error(at, "Required contact name")
      textError(form[key], at)?.let {
        return it
      }
      if (
        key == "name" && PrototypeSpecContract.blankTextPattern.matches(text(form[key]).orEmpty())
      )
        return error(at, "Required contact name")
      if (key == "url" && !PrototypeShareURL.validURL(text(form[key]).orEmpty(), dynamic))
        return error(at, "Share URL must be absolute http(s) with a literal scheme")
    }
    return null
  }

  private fun valueError(
    name: String,
    value: JsonElement?,
    path: String,
    dynamic: Boolean,
    assets: Set<String>?,
  ): PrototypeSpecError? =
    when (name) {
      "text",
      "subject",
      "url" -> stringError(name, value, path, dynamic)
      "contact" -> contactError(value, path, dynamic)
      else -> arrayError(name, value, path, dynamic, assets)
    }

  private fun arrayError(
    name: String,
    value: JsonElement?,
    path: String,
    dynamic: Boolean,
    assets: Set<String>?,
  ): PrototypeSpecError? {
    val array = value as? JsonArray ?: return error(path, "Expected share array")
    val max =
      if (name == "images") PrototypeShare.MAX_PROTOTYPE_SHARE_IMAGES
      else PrototypeShare.MAX_PROTOTYPE_SHARE_FILES
    if (array.size !in 1..max) return error(path, "Share $name must contain 1 to $max items")
    for ((index, entry) in array.withIndex()) {
      val at = "$path[$index]"
      val failure =
        if (name == "images") assetError(entry, at, dynamic, assets)
        else fileError(entry, at, dynamic, assets)
      if (failure != null) return failure
    }
    return null
  }

  private fun fileError(
    value: JsonElement,
    path: String,
    dynamic: Boolean,
    assets: Set<String>?,
  ): PrototypeSpecError? {
    val file = value as? JsonObject ?: return error(path, "Expected share file object")
    for (key in (file.keys + setOf("asset", "mimeType", "name")).sorted()) {
      val at = member(path, key)
      val failure =
        when (key) {
          "asset" -> assetError(file[key], at, false, assets)
          "mimeType" -> mimeError(file[key], at, dynamic)
          "name" -> fileNameError(file[key], at, dynamic)
          else -> error(at, "Unknown file field")
        }
      if (failure != null) return failure
    }
    return null
  }

  private fun mimeError(value: JsonElement?, path: String, dynamic: Boolean): PrototypeSpecError? {
    val valueText = text(value)
    if (dynamic && valueText?.let { maskTemplate(it) != it } == true) return null
    return if (valueText?.let(mime::matches) == true) null
    else error(path, "Share mimeType must be a type/subtype token")
  }

  private fun fileNameError(
    value: JsonElement?,
    path: String,
    dynamic: Boolean,
  ): PrototypeSpecError? {
    val name = text(value)?.let { if (dynamic) maskTemplate(it) else it }
    if (name.isNullOrEmpty())
      return error(
        path,
        "Share file name must be 1 to 128 UTF-8 bytes, with no leading dot, separators or controls",
      )
    if (name.startsWith(".") || name.any(::fileControl) || bytes(name) > 128)
      return error(
        path,
        "Share file name must be 1 to 128 UTF-8 bytes, with no leading dot, separators or controls",
      )
    return null
  }

  private fun fileControl(char: Char): Boolean =
    char in "/\\" ||
      char.code <= 31 ||
      char.code in 127..160 ||
      char.code in 0x2028..0x202e ||
      char.code in 0x2066..0x2069

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
    val items = args.filterKeys { it in setOf("text", "url", "images", "files", "contact") }.values
    if (
      items.none { raw ->
        val value = if (resolved) raw else (raw as? JsonObject)?.get("value")
        text(value)?.let(PrototypeSpecContract.blankTextPattern::matches) != true
      }
    )
      return error(path, "Share requires text, url, images, files or contact")
    return null
  }
}
