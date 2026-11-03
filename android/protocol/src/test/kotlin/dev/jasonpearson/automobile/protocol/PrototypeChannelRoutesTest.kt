package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class PrototypeChannelRoutesTest {
  private val routes =
    Json.parseToJsonElement(
        """[
          {"when":{"pointer":"/type","equals":"message"},"actions":[{"type":"increment","key":"a"}]},
          {"when":{"pointer":"/n","equals":1},"actions":[{"type":"increment","key":"b"}]},
          {"when":{"pointer":"/typing","exists":true},"actions":[{"type":"increment","key":"c"}]},
          {"when":{"pointer":"/gone","exists":false},"actions":[{"type":"increment","key":"d"}]},
          {"actions":[{"type":"increment","key":"e"}]}
        ]""",
      )
      .jsonArray

  private fun key(data: String, event: String? = null, routes: JsonArray = this.routes) =
    PrototypeChannelRoutes.match(routes, Json.parseToJsonElement(data), event)
      ?.first()
      ?.jsonObject
      ?.get("key")
      ?.let { (it as JsonPrimitive).content }

  @Test
  fun `the first matching route wins`() {
    assertEquals("a", key("""{"type":"message","typing":true}"""))
    assertEquals("c", key("""{"type":"other","typing":false,"gone":1}"""))
  }

  @Test
  fun `equals compares numbers by value`() {
    assertEquals("b", key("""{"n":1.0,"gone":1}"""))
  }

  @Test
  fun `exists false matches a missing member and a catch-all matches the rest`() {
    assertEquals("d", key("""{"x":1}"""))
    assertEquals("e", key("""{"gone":null}"""))
    assertEquals("d", key("\"plain text\""))
  }

  @Test
  fun `event matchers default the sse event name to message`() {
    val sse =
      Json.parseToJsonElement(
          """[{"when":{"event":"message"},"actions":[{"type":"increment","key":"m"}]},
              {"when":{"event":"ping"},"actions":[{"type":"increment","key":"p"}]}]""",
        )
        .jsonArray
    assertEquals("m", key("{}", null, sse))
    assertEquals("p", key("{}", "ping", sse))
    assertNull(key("{}", "other", sse))
  }

  @Test
  fun `no routes match nothing`() {
    assertNull(PrototypeChannelRoutes.match(null, JsonPrimitive(1), null))
  }
}
