package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.member
import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.strings
import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Located
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/**
 * Rules for the `webView` node (#14312) that the contract cannot express, the twin of TypeScript's
 * `prototypeWebView.ts`: `webview` in `requires.platform`; allowed origins that name a DNS host,
 * never an IP literal or `localhost`; a literal URL authority that is one of the allowed origins;
 * and navigation, title and back keys that name declared state of the right type. Contract only: no
 * runtime draws a web view.
 */
object PrototypeWebView {
  /** An imported page cannot load subresources while the library's network switch is off. */
  data class ImportError(val path: String)

  /** Checks authored node positions, including unexpanded repeat templates, in tree order. */
  fun importError(spec: JsonObject, networkAllowed: Boolean): ImportError? {
    if (networkAllowed) return null
    val root = spec["root"] as? JsonObject ?: return null
    fun first(node: JsonObject, path: String): ImportError? =
      if (node.text("type") == "webView") ImportError(path)
      else PrototypeRepeatTree.childrenOf(node, path).firstNotNullOfOrNull { first(it.node, it.path) }
    return first(root, "root")
  }

  /** Convenience for an already validated saved library spec. */
  fun importError(spec: String, networkAllowed: Boolean): ImportError? =
    if (networkAllowed) null
    else importError(Json.parseToJsonElement(spec) as JsonObject, networkAllowed)

  private val webViewCalls = setOf("webview.back", "webview.reload")

  private val stateKeys =
    listOf("navigationStateKey" to false, "titleKey" to false, "canGoBackKey" to true)

  /** A host whose last label is numeric or hexadecimal parses as an IPv4 address. */
  private val ipLikeLabel = Regex("^(?:[0-9]+|0x[0-9a-f]*)$")

  private val literalAuthority = Regex("^https://([^/?#]*)")

  /** The ids of the spec's `webView` nodes, the values a `webview.*` `node` argument may name. */
  internal fun ids(nodes: List<Located>): Set<String> =
    nodes.filter { it.value.text("type") == "webView" }.mapNotNull { it.value.text("id") }.toSet()

  /** The first `webView` node rule a spec breaks. */
  internal fun error(root: JsonObject, nodes: List<Located>): PrototypeSpecError? {
    val webViews = nodes.filter { it.value.text("type") == "webView" }
    if (webViews.isEmpty()) return null
    val requires = root.member("requires") ?: JsonObject(emptyMap())
    val declared = "webview" in requires.strings("platform")
    val state = root.member("state").orEmpty()
    return webViews.firstNotNullOfOrNull { (node, path) -> nodeError(node, path, declared, state) }
  }

  /** `localhost`, a `.localhost` name, or a host a URL parser would read as an IP address. */
  internal fun privateHost(host: String): Boolean =
    host == "localhost" ||
      host.endsWith(".localhost") ||
      ipLikeLabel.matches(host.substringAfterLast('.'))

  private fun nodeError(
    node: JsonObject,
    path: String,
    declared: Boolean,
    state: Map<String, JsonElement>,
  ): PrototypeSpecError? {
    if (!declared) return fail(path, "webView requires webview in requires.platform")
    val origins =
      (node["allowedOrigins"] as? JsonArray).orEmpty().mapNotNull {
        (it as? JsonPrimitive)?.contentOrNull
      }
    val privateIndex = origins.indexOfFirst {
      privateHost(it.removePrefix("https://").substringBefore(':'))
    }
    if (privateIndex >= 0) {
      return fail(
        "$path.allowedOrigins[$privateIndex]",
        "allowedOrigins must name a DNS host, not localhost or an IP address",
      )
    }
    val authority = node.text("url")?.let { literalAuthority.find(it)?.groupValues?.get(1) }
    // An allowed origin never spells the default port, so `:443` is dropped before comparing.
    val origin = authority?.let { "https://${it.lowercase().removeSuffix(":443")}" }
    if (authority != null && '{' !in authority && origin !in origins) {
      return fail("$path.url", "webView url origin must be one of allowedOrigins")
    }
    return stateKeys.firstNotNullOfOrNull { (field, boolean) ->
      node
        .text(field)
        ?.takeUnless {
          (state[it] as? JsonPrimitive)?.let { value -> isType(value, boolean) } == true
        }
        ?.let {
          fail(
            "$path.$field",
            "$field must name a declared ${if (boolean) "boolean" else "string"} state key",
          )
        }
    }
  }

  private fun isType(value: JsonPrimitive, boolean: Boolean): Boolean =
    if (boolean) !value.isString && value.booleanOrNull != null else value.isString

  /** A `webview.*` call whose literal `node` argument names no `webView` node. */
  internal fun callError(action: JsonObject, path: String, webViews: Set<String>): PrototypeSpecError? {
    if (action.text("call") !in webViewCalls) return null
    val target = action.member("args")?.member("node")?.text("value") ?: return null
    return if (target in webViews) null else fail("$path.args.node.value", "Unknown webView")
  }
}
