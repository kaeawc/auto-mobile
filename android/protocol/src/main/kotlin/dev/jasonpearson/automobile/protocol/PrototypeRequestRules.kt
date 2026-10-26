package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.keyPath
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import dev.jasonpearson.automobile.protocol.PrototypeValidationValues.isValidLiteral
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add

internal object PrototypeRequestRules {
  private val forbiddenHeaders =
    setOf(
      "host",
      "connection",
      "upgrade",
      "transfer-encoding",
      "content-length",
      "te",
      "trailer",
      "keep-alive",
      "cookie",
      "origin",
      "expect",
    )
  val headerNamePattern = Regex("^[!#$%&'*+\\-.^_`|~0-9A-Za-z]+$")

  /**
   * Static checks for `request` (#12523) that the contract cannot express (the twin of
   * `prototypeRequestsError`): the URL scheme, bodies on GET and HEAD, the `into` path and its
   * `__meta` sibling, header names and literal entries, and the emit name reserved for request
   * events.
   */
  fun requestActionErrors(context: Context): PrototypeSpecError? {
    for ((value, path) in context.actions) {
      val error =
        when (value.text("type")) {
          "emit" ->
            if (value.text("name") == PrototypeRequests.EVENT_NAME)
              fail(
                "$path.name",
                "The emit name ${PrototypeRequests.EVENT_NAME} is reserved for request events",
              )
            else null
          "request" ->
            requestError(value, path)
              ?: appendError(value, path, (context.root as? JsonObject)?.get("data") as? JsonObject)
          else -> null
        }
      if (error != null) return error
    }
    return null
  }

  fun requestError(action: JsonObject, at: String): PrototypeSpecError? {
    action.text("url")?.let(::requestUrlError)?.let {
      return fail("$at.url", it)
    }
    val method = action.text("method") ?: PrototypeRequests.DEFAULT_METHOD
    if (action["body"] != null && method in PrototypeRequests.BODYLESS_METHODS) {
      return fail("$at.body", "A GET or HEAD request cannot have a body")
    }
    action.text("into")?.let(::requestIntoError)?.let {
      return fail("$at.into", it)
    }
    return requestEntryError(action["headers"], at, "headers")
      ?: requestEntryError(action["query"], at, "query")
  }

  private fun appendError(action: JsonObject, at: String, data: JsonObject?): PrototypeSpecError? {
    val to = (action["append"] as? JsonObject)?.text("to") ?: return null
    val path = "$at.append.to"
    requestIntoError(to)?.let {
      return fail(path, it)
    }
    val into = action.text("into")
    if (into != null && overlaps(to, into)) return fail(path, "append.to must not overlap into")
    if (!to.split('/').contains("{index}") && data != null) {
      val target = PrototypeDataPointer.resolve(data, to.removePrefix("/data"))
      if (target != null && target !is kotlinx.serialization.json.JsonArray)
        return fail(path, "append.to must name an array")
    }
    return null
  }

  private fun overlaps(to: String, into: String): Boolean =
    to == into || to.startsWith("$into/") || into.startsWith("$to/")

  fun requestUrlError(url: String): String? =
    if ('{' in url) {
      if (
        url.startsWith("http://", ignoreCase = true) ||
          url.startsWith("https://", ignoreCase = true)
      )
        null
      else "A templated request url must start with a literal http:// or https://"
    } else if (PrototypeUrl.parse(url) is PrototypeUrl.Result.Absolute) null
    else "A request url must be an absolute http or https URL"

  fun requestIntoError(into: String): String? {
    val pointer =
      PrototypeDataWriter.pathPointer(PrototypeRepeatTemplate.bindDataPath(into, 0))
        ?: return "request into is /data/<RFC 6901 pointer> and addresses a member of data"
    val last = pointer.substring(pointer.lastIndexOf('/') + 1)
    return if (last == "-" || (last.isNotEmpty() && last.all { it in '0'..'9' }))
      "request into must name an object member, not an array element, so into__meta can be written beside it"
    else null
  }

  fun requestEntryError(
    entries: JsonElement?,
    at: String,
    field: String,
  ): PrototypeSpecError? {
    val seenHeaders = HashSet<String>()
    for ((name, value) in (entries as? JsonObject).orEmpty()) {
      val entryPath = keyPath("$at.$field", name)
      val literal = (value as? JsonObject)?.get("value")
      if (field == "headers") {
        headerError(name, literal ?: value, seenHeaders)?.let {
          return fail(entryPath, it)
        }
      }
      if (literal != null && !isValidLiteral(literal)) {
        return fail(
          "$entryPath.value",
          "A header or query literal must be a string, number or boolean",
        )
      }
    }
    return null
  }

  private fun headerError(
    name: String,
    value: JsonElement,
    seen: MutableSet<String>,
  ): String? {
    if (name.lowercase() in forbiddenHeaders || name.startsWith("proxy-", ignoreCase = true))
      return "Forbidden request header"
    if (!headerNamePattern.matches(name)) return "Invalid header name"
    // Header names are case-insensitive: X-Test and x-test are one header.
    if (!seen.add(name.lowercase())) return "Duplicate header name (names are case-insensitive)"
    val text = (value as? JsonPrimitive)?.content
    if (text?.any { it == '\r' || it == '\n' } == true) return "CR/LF in header value"
    return null
  }
}
