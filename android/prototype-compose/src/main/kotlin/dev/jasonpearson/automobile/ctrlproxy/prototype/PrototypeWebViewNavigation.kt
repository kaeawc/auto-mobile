package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeAction
import dev.jasonpearson.automobile.protocol.PrototypeScalar
import dev.jasonpearson.automobile.protocol.PrototypeWebViewNode
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Main-thread navigation state and the authored interactions it emits. */
internal class PrototypeWebViewNavigation(
  private var node: PrototypeWebViewNode,
  private val page: PrototypeWebPage,
  private var interact: (PrototypeInteraction.WebNavigation) -> Unit,
) {
  private var loading = false

  fun update(node: PrototypeWebViewNode, interact: (PrototypeInteraction.WebNavigation) -> Unit) {
    this.node = node
    this.interact = interact
  }

  fun reset() {
    loading = false
  }

  fun permits(url: String, mainFrame: Boolean): Boolean {
    val allowed =
      PrototypeWebViewPolicy.check(url, node.allowedOrigins, mainFrame) ==
        PrototypeWebViewPolicy.Allow
    if (!allowed && mainFrame) blocked(url)
    return allowed
  }

  fun load(url: String) {
    if (permits(url, true)) {
      started(url)
      page.load(url)
    }
  }

  fun started(url: String) {
    if (permits(url, true) && !loading) {
      loading = true
      publish("loading")
    }
  }

  fun finished(url: String) {
    if (!loading || !permits(url, true)) return
    loading = false
    publish("loaded", url, node.onNavigate.orEmpty())
  }

  fun blocked(url: String) {
    loading = false
    publish("blocked", url, node.onBlockedNavigation.orEmpty())
  }

  fun failed() {
    loading = false
    publish("error")
  }

  private fun publish(
    status: String,
    url: String = "",
    actions: List<PrototypeAction> = emptyList(),
  ) {
    interact(
      PrototypeInteraction.WebNavigation(
        buildMap {
          node.navigationStateKey?.let { put(it, PrototypeScalar.Text(status)) }
          // Only a committed page has a title; a previous page's title must not leak into an error.
          node.titleKey?.let {
            put(it, PrototypeScalar.Text(if (status == "loaded") boundedTitle(page.title) else ""))
          }
          node.canGoBackKey?.let { put(it, PrototypeScalar.BooleanValue(page.canGoBack)) }
        },
        actions.map { bindWebViewUrl(it, url) },
      ),
    )
  }
}

/**
 * A page controls its title, and an oversized one would push the state write past the spec size
 * limit, so the write is refused and the navigation outcome lost. Bound it before it is written.
 */
internal const val MAX_WEB_VIEW_TITLE_LENGTH = 256

internal fun boundedTitle(title: String): String {
  if (title.length <= MAX_WEB_VIEW_TITLE_LENGTH) return title
  val cut = title.take(MAX_WEB_VIEW_TITLE_LENGTH)
  return if (cut.last().isHighSurrogate()) cut.dropLast(1) else cut
}

private fun bindWebViewUrl(action: PrototypeAction, url: String): PrototypeAction {
  val json = Json
  val serializer = PrototypeAction.serializer()
  return json.decodeFromJsonElement(
    serializer,
    bindWebViewUrl(json.encodeToJsonElement(serializer, action), url),
  )
}

private fun bindWebViewUrl(value: JsonElement, url: String): JsonElement =
  when (value) {
    is JsonObject -> JsonObject(value.mapValues { (_, child) -> bindWebViewUrl(child, url) })
    is JsonArray -> JsonArray(value.map { bindWebViewUrl(it, url) })
    is JsonPrimitive ->
      if (value.isString && "{url}" in value.content)
        JsonPrimitive(value.content.replace("{url}", url))
      else value
  }
