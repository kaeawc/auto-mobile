package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.keyPath
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import dev.jasonpearson.automobile.protocol.PrototypeValidationValues.isValidLiteral
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
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
          "request" -> requestError(value, path)
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
      if (
        field == "headers" &&
          (name.lowercase() in forbiddenHeaders || name.startsWith("proxy-", ignoreCase = true))
      ) {
        return fail(entryPath, "Forbidden request header")
      }
      if (field == "headers" && !headerNamePattern.matches(name)) {
        return fail(entryPath, "Invalid header name")
      }
      // Header names are case-insensitive: X-Test and x-test are one header.
      if (field == "headers" && !seenHeaders.add(name.lowercase())) {
        return fail(entryPath, "Duplicate header name (names are case-insensitive)")
      }
      val literal = (value as? JsonObject)?.get("value")
      val text = ((literal ?: value) as? kotlinx.serialization.json.JsonPrimitive)?.content
      if (field == "headers" && text != null && text.any { it == '\r' || it == '\n' }) {
        return fail(entryPath, "CR/LF in header value")
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
}
