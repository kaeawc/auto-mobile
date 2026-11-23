package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeEmitAction
import dev.jasonpearson.automobile.protocol.PrototypeFullscreenPlacement
import dev.jasonpearson.automobile.protocol.PrototypeScalar
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeWebViewNode
import dev.jasonpearson.automobile.protocol.PrototypeWindow
import dev.jasonpearson.automobile.prototype.PlatformCall
import dev.jasonpearson.automobile.prototype.PlatformCallResult
import dev.jasonpearson.automobile.prototype.PlatformErrorCode
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PrototypeWebViewNavigationTest {
  private val allowed = "https://example.com/"
  private val denied = "https://other.com/"
  private val updates = mutableListOf<PrototypeInteraction.WebNavigation>()
  private val view = FakePage()
  private val node =
    PrototypeWebViewNode(
      url = allowed,
      allowedOrigins = listOf("https://example.com"),
      navigationStateKey = "nav",
      titleKey = "title",
      canGoBackKey = "back",
      onNavigate = listOf(PrototypeEmitAction(name = "finished", payload = JsonPrimitive("{url}"))),
      onBlockedNavigation =
        listOf(PrototypeEmitAction(name = "blocked", payload = JsonPrimitive("{url}"))),
    )
  private val navigation = PrototypeWebViewNavigation(node, view) { updates += it }

  @Test
  fun blocksResolvedUrlBeforeLoadingAndBindsBlockedAction() {
    val spec =
      PrototypeSpec(
        "test",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        root = node.copy(url = "https://{data:/domain}/"),
        data = JsonObject(mapOf("domain" to JsonPrimitive("other.com"))),
      )
    val resolved = mapPrototypeSpec(spec).root.text
    assertEquals(denied, resolved)
    navigation.load(resolved)
    assertTrue(view.loads.isEmpty())
    val update = updates.single()
    assertEquals(PrototypeScalar.Text("blocked"), update.writes["nav"])
    assertEquals(JsonPrimitive(denied), (update.actions.single() as PrototypeEmitAction).payload)
  }

  @Test
  fun publishesLoadedTitleHistoryAndBoundActionOnlyOnce() {
    navigation.load(allowed)
    assertEquals(listOf(allowed), view.loads)
    navigation.started(allowed)
    view.canGoBack = true
    view.title = "Article"
    navigation.finished(allowed)
    navigation.finished(allowed)
    val update = updates.last()
    assertEquals(PrototypeScalar.Text("loaded"), update.writes["nav"])
    assertEquals(PrototypeScalar.Text("Article"), update.writes["title"])
    assertEquals(PrototypeScalar.BooleanValue(true), update.writes["back"])
    assertEquals(JsonPrimitive(allowed), (update.actions.single() as PrototypeEmitAction).payload)
    assertEquals(1, updates.count { it.actions.isNotEmpty() })
  }

  @Test
  fun boundsAnOversizedPageTitleBeforeItIsWritten() {
    navigation.load(allowed)
    view.title = "t".repeat(MAX_WEB_VIEW_TITLE_LENGTH * 1000)
    navigation.finished(allowed)
    val title = updates.last().writes["title"] as PrototypeScalar.Text
    assertEquals(MAX_WEB_VIEW_TITLE_LENGTH, title.value.length)
  }

  @Test
  fun backAndReloadRouteOnlyToAttachedNode() = runTest {
    val fetcher = PrototypeWebFetcher { _, _, _ -> error("no fetch expected") }
    val module =
      PrototypeWebViewModule(
        fetcher,
        object : PrototypeMainThread {
          override fun isMainThread() = true

          override fun post(work: () -> Unit): Boolean = error("already on main")
        },
      )
    module.attach("page", view)
    fun call(name: String, node: String = "page") =
      PlatformCall("call", "webview.$name", JsonObject(mapOf("node" to JsonPrimitive(node))))
    assertTrue(module.call(call("back")) is PlatformCallResult.Success)
    assertEquals(0, view.backs)
    view.canGoBack = true
    assertTrue(module.call(call("back")) is PlatformCallResult.Success)
    assertTrue(module.call(call("reload")) is PlatformCallResult.Success)
    assertEquals(1, view.backs)
    assertEquals(1, view.reloads)
    assertEquals(
      PlatformErrorCode.UNAVAILABLE,
      (module.call(call("reload", "missing")) as PlatformCallResult.Failure).error.code,
    )
    module.detach("page", view)
    assertTrue(module.call(call("reload")) is PlatformCallResult.Failure)
  }

  private class FakePage : PrototypeWebPage {
    val loads = mutableListOf<String>()
    var backs = 0
    var reloads = 0
    override var canGoBack = false
    override var title = ""

    override fun load(url: String) {
      loads += url
    }

    override fun back() {
      backs++
    }

    override fun reload() {
      reloads++
    }
  }
}
