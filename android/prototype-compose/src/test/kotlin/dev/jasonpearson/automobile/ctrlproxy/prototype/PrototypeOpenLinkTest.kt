package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

class PrototypeOpenLinkTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmValidator() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  private val events = mutableListOf<PrototypeEvent>()

  private fun runtime(): PrototypeRuntime {
    val input =
      """{
      "id":"links", "window":{"placement":{"type":"fullscreen"}},
      "requires":["prototype_links_v1"], "state":{"title":""},
      "root":{"type":"stack","id":"main","start":"feed",
        "screens":{"feed":{"type":"text","text":"Feed"},"post":{"type":"text","text":"Post"}},
        "routes":{"feed":{},"post":{"params":{"postId":"string","ref":"string"}}}},
      "links":[{"path":"/post/{postId}","query":{"ref":{"type":"string","secret":true}},
        "actions":[{"type":"setState","key":"title","value":{"link":"postId"}}, {"type":"setStack","stack":"main","path":[{"screen":"feed"},
          {"screen":"post","params":{"postId":{"link":"postId"},"ref":{"link":"ref"}}}]}]}]
    }"""
    val result = PrototypeSpecValidator.validate(input)
    assertTrue(result.toString(), result is PrototypeSpecValidation.Success)
    var sequence = 0L
    return PrototypeRuntime(
        (result as PrototypeSpecValidation.Success).spec,
        sink = { events += it },
        clock = { 42L },
        nextSequence = { ++sequence },
        warn = {},
      )
      .also { it.registeredLinkSchemes = listOf("amp-feed") }
  }

  @Test
  fun `link binds captures and queries without platform and Back lands below`() = runTest {
    val runtime = runtime()
    runtime.openLink("amp-feed://post/41?ref=private&%72ef=also-private&visible=yes")
    assertEquals(listOf("feed", "post"), runtime.current.stacks.getValue("main").path)
    assertEquals(JsonPrimitive("41"), runtime.current.stacks.getValue("main").paramsAt(1)["postId"])
    assertEquals(
      JsonPrimitive("private"),
      runtime.current.stacks.getValue("main").paramsAt(1)["ref"],
    )
    assertEquals(PrototypeScalar.Text("41"), runtime.current.state["title"])
    val opened = events.single { it.kind == PrototypeEventKind.LINK_OPENED }
    assertNull(opened.name)
    assertEquals(
      buildJsonObject {
        put("url", "amp-feed://post/41?visible=yes")
        put("entry", "/post/{postId}")
      },
      opened.payload,
    )
    runtime.handle(PrototypeInteraction.Back)
    assertEquals(listOf("feed"), runtime.current.stacks.getValue("main").path)
  }

  @Test
  fun `unmatched and unregistered schemes run no actions and redact secrets`() = runTest {
    val runtime = runtime()
    for (url in
      listOf(
        "amp-feed://missing?ref=private",
        "amp-other://post/41?ref=private",
        "https://evil.test/post/41?ref=private",
      )) {
      runtime.openLink(url)
      assertEquals(listOf("feed"), runtime.current.stacks.getValue("main").path)
      assertEquals(PrototypeEventKind.LINK_UNMATCHED, events.last().kind)
      assertNull(events.last().name)
      assertEquals(setOf("url"), events.last().payload!!.jsonObject.keys)
      assertFalse(events.last().payload.toString().contains("private"))
    }
  }

  @Test
  fun `link acceptance precedes actions so dismissal stays final`() = runTest {
    val runtime = runtime()
    val entries =
      runtime.current.spec.links!!.map { raw ->
        val entry = raw.jsonObject
        val actions = entry.getValue("actions").jsonArray
        JsonObject(
          entry + ("actions" to JsonArray(actions + buildJsonObject { put("type", "dismiss") })),
        )
      }
    runtime.replace(runtime.current.spec.copy(links = JsonArray(entries)))
    runtime.openLink("amp-feed://post/41?ref=private")
    assertEquals(PrototypeEventKind.LINK_OPENED, events.first().kind)
    assertNull(events.first().name)
    assertEquals(PrototypeEventKind.DISMISSED, events.last().kind)
    assertFalse(runtime.current.active)
  }

  @Test
  fun `absent optional query cannot crash the host or write an invalid scalar`() = runTest {
    val runtime = runtime()
    val raw = runtime.current.spec.links!![0].jsonObject
    val actions = raw.getValue("actions").jsonArray.toMutableList()
    actions[0] = buildJsonObject {
      put("type", "setState")
      put("key", "title")
      put("value", buildJsonObject { put("link", "ref") })
    }
    val entry =
      JsonObject(
        raw +
          mapOf(
            "query" to buildJsonObject { put("ref", "string?") },
            "actions" to JsonArray(actions),
          ),
      )
    runtime.replace(runtime.current.spec.copy(links = JsonArray(listOf(entry))))
    runtime.openLink("amp-feed://post/41")
    assertEquals(PrototypeEventKind.LINK_OPENED, events.single().kind)
    assertNull(events.single().name)
    assertEquals(PrototypeScalar.Text(""), runtime.current.state["title"])
    assertEquals(listOf("feed"), runtime.current.stacks.getValue("main").path)
  }

  @Test
  fun `absent optional binding refuses the whole list instead of writing null data`() = runTest {
    val runtime = runtime()
    val raw = runtime.current.spec.links!![0].jsonObject
    val write = buildJsonObject {
      put("type", "setData")
      put("path", "/data/draft")
      put("value", buildJsonObject { put("link", "ref") })
    }
    val entry =
      JsonObject(
        raw +
          mapOf(
            "query" to buildJsonObject { put("ref", "string?") },
            "actions" to JsonArray(raw.getValue("actions").jsonArray.take(1) + write),
          ),
      )
    val data = buildJsonObject { put("draft", "keep") }
    runtime.replace(runtime.current.spec.copy(data = data, links = JsonArray(listOf(entry))))
    runtime.openLink("amp-feed://post/41")
    assertEquals(PrototypeEventKind.LINK_OPENED, events.single().kind)
    assertNull(events.single().name)
    assertEquals(data, runtime.current.spec.data)
    assertEquals(PrototypeScalar.Text(""), runtime.current.state["title"])
    assertEquals(listOf("feed"), runtime.current.stacks.getValue("main").path)
  }

  @Test
  fun `nested timer actions unwrap a linked state value`() = runTest {
    val runtime = runtime()
    val raw = runtime.current.spec.links!![0].jsonObject
    val actions = raw.getValue("actions").jsonArray.toMutableList()
    val linkedTitle = actions[0]
    actions[0] = buildJsonObject {
      put("type", "startTimer")
      put("id", "open")
      put("afterMs", 1000)
      put("actions", JsonArray(listOf(linkedTitle)))
    }
    val entry = JsonObject(raw + ("actions" to JsonArray(actions)))
    runtime.replace(runtime.current.spec.copy(links = JsonArray(listOf(entry))))
    runtime.openLink("amp-feed://post/41?ref=private")
    assertEquals(listOf("feed", "post"), runtime.current.stacks.getValue("main").path)
    assertEquals("open", runtime.timerReports().single().id)
    assertEquals(PrototypeScalar.Text(""), runtime.current.state["title"])
    assertEquals(1, runtime.advanceClock(1000))
    assertEquals(PrototypeScalar.Text("41"), runtime.current.state["title"])
  }

  @Test
  fun `missing capability ignores links`() = runTest {
    val runtime = runtime()
    runtime.replace(runtime.current.spec.copy(requires = null))
    runtime.openLink("amp-feed://post/41?ref=private")
    assertTrue(events.isEmpty())
    assertEquals(listOf("feed"), runtime.current.stacks.getValue("main").path)
  }
}
