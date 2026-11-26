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
  // The status last published and the title written with it, so a late title is written once.
  private var status: String? = null
  private var publishedTitle = ""

  fun update(node: PrototypeWebViewNode, interact: (PrototypeInteraction.WebNavigation) -> Unit) {
    this.node = node
    this.interact = interact
  }

  fun reset() {
    loading = false
    status = null
    publishedTitle = ""
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

  /**
   * WebView can deliver a page's title after onPageFinished (onReceivedTitle), so a loaded page's
   * title is written again whenever it changes (#19418). Nothing is written before the page loaded.
   */
  fun titleChanged() {
    val key = node.titleKey ?: return
    if (status != "loaded") return
    val title = boundedTitle(page.title)
    if (title == publishedTitle) return
    publishedTitle = title
    interact(
      PrototypeInteraction.WebNavigation(mapOf(key to PrototypeScalar.Text(title)), emptyList()),
    )
  }

  private fun publish(
    status: String,
    url: String = "",
    actions: List<PrototypeAction> = emptyList(),
  ) {
    this.status = status
    // Only a committed page has a title; a previous page's title must not leak into an error.
    publishedTitle = if (status == "loaded") boundedTitle(page.title) else ""
    interact(
      PrototypeInteraction.WebNavigation(
        buildMap {
          node.navigationStateKey?.let { put(it, PrototypeScalar.Text(status)) }
          node.titleKey?.let { put(it, PrototypeScalar.Text(publishedTitle)) }
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
