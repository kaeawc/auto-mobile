package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PrototypeRouteRuntimeTest {
  private val json = Json { classDiscriminator = "type" }

  private fun obj(text: String) = Json.parseToJsonElement(text).jsonObject

  private fun node(text: String): PrototypeNode =
    json.decodeFromJsonElement(PrototypeNode.serializer(), Json.parseToJsonElement(text))

  private val stack =
    node(
      """{"type":"stack","id":"nav","start":"feed","screens":{
        "feed":{"type":"text","text":"Feed"},
        "post":{"type":"column","children":[
          {"type":"text","text":"Post {route.postId} #{index}","visibleWhen":{"key":"pinned","equals":"{route.pinned}"}},
          {"type":"button","label":"Like","onTap":[
            {"type":"setData","path":"/data/posts/{route.postId}/liked","value":{"value":true}},
            {"type":"push","stack":"nav","screen":"post","params":{"postId":"{route.postId}","pinned":"{route.pinned}"}}]}]}},
        "routes":{"post":{"params":{"postId":"string","pinned":"boolean"}}}}""",
    )
      as PrototypeStackNode

  private val inputs =
    object : EmitContextInputs {
      override fun state(key: String): JsonElement? = if (key == "count") JsonPrimitive(2) else null

      override fun page(id: String): Int? = null

      override fun data(pointer: String): JsonElement? =
        if (pointer == "/post/id") JsonPrimitive("a/b") else null

      override fun platform(pointer: String): JsonElement? = null

      override fun event(pointer: String): JsonElement? = null
    }

  @Test
  fun `params resolve literals and bindings, and only scalars`() {
    assertEquals(
      obj("""{"a":"x","b":2,"c":"a/b","d":true}"""),
      PrototypeRouteRuntime.resolve(
        mapOf(
          "a" to JsonPrimitive("x"),
          "b" to obj("""{"state":"count"}"""),
          "c" to obj("""{"data":"/post/id"}"""),
          "d" to obj("""{"value":true}"""),
        ),
        inputs,
      ),
    )
    assertNull(PrototypeRouteRuntime.resolve(mapOf("a" to obj("""{"state":"missing"}""")), inputs))
    assertNull(PrototypeRouteRuntime.resolve(mapOf("a" to obj("""{"value":{"x":1}}""")), inputs))
  }

  @Test
  fun `params fit only the exact declaration`() {
    assertTrue(PrototypeRouteRuntime.fits(stack, "post", obj("""{"postId":"1","pinned":false}""")))
    assertTrue(PrototypeRouteRuntime.fits(stack, "feed", obj("{}")))
    assertFalse(PrototypeRouteRuntime.fits(stack, "post", obj("""{"postId":"1"}""")))
    assertFalse(PrototypeRouteRuntime.fits(stack, "post", obj("""{"postId":1,"pinned":false}""")))
    assertFalse(PrototypeRouteRuntime.fits(stack, "feed", obj("""{"x":"1"}""")))
    assertFalse(PrototypeRouteRuntime.fits(stack, "gone", obj("{}")))
  }

  @Test
  fun `the top screen binds text, typed operands and escaped pointer segments`() {
    val snapshot =
      PrototypeStackSnapshot.of(
        listOf("feed", "post"),
        listOf(obj("{}"), obj("""{"postId":"a/b~c","pinned":true}""")),
      )
    val bound =
      PrototypeRouteRuntime.bindRoot(stack, mapOf("nav" to snapshot)) as PrototypeStackNode
    val encoded = json.encodeToJsonElement(PrototypeNode.serializer(), bound).jsonObject
    val post = encoded.getValue("screens").jsonObject.getValue("post").toString()
    assertTrue("\"Post a/b~c #{index}\"" in post, post)
    assertTrue("\"equals\":true" in post, post)
    assertTrue("\"/data/posts/a~1b~0c/liked\"" in post, post)
    assertTrue("\"params\":{\"postId\":\"a/b~c\",\"pinned\":true}" in post, post)
    // Lifecycle lists are bound when they run, not with the tree.
    assertEquals(
      json.encodeToJsonElement(PrototypeNode.serializer(), stack).jsonObject["routes"],
      encoded["routes"],
    )
  }

  @Test
  fun `a root whose stacks have no top params is returned as is`() {
    assertSame(
      stack,
      PrototypeRouteRuntime.bindRoot(stack, mapOf("nav" to PrototypeStackSnapshot(listOf("feed")))),
    )
  }

  @Test
  fun `lifecycle actions bind to the entry that runs them`() {
    val actions = listOf<PrototypeAction>(PrototypeEmitAction("entered_{route.postId}"))
    val bound = PrototypeRouteRuntime.bindActions(actions, obj("""{"postId":"41"}"""))
    assertEquals("entered_41", (bound.single() as PrototypeEmitAction).name)
  }

  @Test
  fun `the stored path round-trips and a stale one is refused`() {
    val snapshot =
      PrototypeStackSnapshot.of(
        listOf("feed", "post"),
        listOf(obj("{}"), obj("""{"postId":"1","pinned":false}""")),
      )
    val stored = PrototypeRouteRuntime.storedValue(snapshot)
    assertEquals(
      Json.parseToJsonElement(
        """[{"screen":"feed"},{"screen":"post","params":{"postId":"1","pinned":false}}]""",
      ),
      stored,
    )
    assertEquals(snapshot, PrototypeRouteRuntime.restore(stack, stored))
    for (stale in
      listOf(
        """[]""",
        """{"screen":"feed"}""",
        """[{"screen":"gone"}]""",
        """[{"screen":"post","params":{"postId":"1"}}]""",
        """[{"screen":"feed","extra":1}]""",
      )) assertNull(PrototypeRouteRuntime.restore(stack, Json.parseToJsonElement(stale)), stale)
  }

  @Test
  fun `snapshots drop params when every entry has none`() {
    assertNull(PrototypeStackSnapshot.of(listOf("a", "b"), listOf(obj("{}"), obj("{}"))).params)
    val snapshot =
      PrototypeStackSnapshot.of(listOf("a", "b"), listOf(obj("{}"), obj("""{"x":1}""")))
    assertEquals(JsonObject(emptyMap()), snapshot.paramsAt(0))
    assertNull(snapshot.dropLast().params)
  }
}
