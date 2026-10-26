package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

class PrototypeLazyListTest {
  private val json = Json

  private fun obj(text: String) = json.parseToJsonElement(text).jsonObject

  private val list =
    """{"type":"list","repeat":{"items":{"path":"/items"},"as":"item","key":"id"},"children":[{"type":"text","text":"{item.title}"}]}"""

  private fun spec(root: JsonObject, data: JsonObject = obj("""{"items":[]}""")) =
    obj("""{"id":"feed","window":{"placement":{"type":"fullscreen"}}}""") +
      mapOf("root" to root, "data" to data)

  @Test
  fun `rows at the list limit count their image and node template once`() {
    val root =
      obj(list).let {
        JsonObject(
          it + ("children" to JsonArray(listOf(obj("""{"type":"image","asset":"pic"}""")))),
        )
      }
    val limit = PrototypeSpecValidator.MAX_PROTOTYPE_LIST_ITEMS
    val items = JsonArray((0 until limit).map { obj("""{"id":$it,"title":"Row"}""") })
    val input = JsonObject(spec(root, JsonObject(mapOf("items" to items))))
    assertTrue(PrototypeSpecValidator.validate(input.toString()) is PrototypeSpecValidation.Success)
    val projected = PrototypeRepeatData(input.getValue("data").jsonObject).items("/items")
    assertEquals(limit, projected.size)
    assertEquals(JsonPrimitive(limit - 1), projected.last()["id"])
  }

  @Test
  fun `smallest exact matching list window includes header footer traversal`() {
    val first = JsonObject(obj(list) + ("maxItems" to JsonPrimitive(8)))
    val second = JsonObject(obj(list) + ("maxItems" to JsonPrimitive(3)))
    val root =
      obj("""{"type":"column"}""").let {
        JsonObject(it + ("children" to JsonArray(listOf(first, second))))
      }
    val input = JsonObject(spec(root))
    assertEquals(3, prototypeListMaxItemsFor(input, "/data/items"))
    assertNull(prototypeListMaxItemsFor(input, "/data/items/child"))
    val nested = JsonObject(first + ("footer" to second))
    assertEquals(3, prototypeListMaxItemsFor(JsonObject(spec(nested)), "/data/items"))
  }

  @Test
  fun `headers do not bind row placeholders and refresh writes preserve boolean type`() {
    val root =
      JsonObject(
        obj(list) + mapOf("header" to obj("""{"type":"textField","stateKey":"v_{index}"}""")),
      )
    val result =
      PrototypeSpecValidator.validate(JsonObject(spec(root)).toString())
        as PrototypeSpecValidation.Failure
    assertEquals("root.header.stateKey", result.error.path)
    assertEquals("State key placeholder outside a repeat template", result.error.message)
    val refreshed =
      JsonObject(
        obj(list) +
          ("refresh" to
            obj(
              """{"stateKey":"refreshing","onRefresh":[{"type":"setState","key":"refreshing","value":"bad"}]}""",
            )),
      )
    val input = JsonObject(spec(refreshed) + ("state" to obj("""{"refreshing":false}""")))
    val invalid =
      PrototypeSpecValidator.validate(input.toString()) as PrototypeSpecValidation.Failure
    assertEquals("root.refresh.onRefresh[0].value", invalid.error.path)
  }

  @Test
  fun `resolver keeps source pointers and resolves header and footer data text`() {
    val root =
      JsonObject(
        obj(list) +
          mapOf(
            "header" to obj("""{"type":"text","text":"{data:/title}"}"""),
            "footer" to obj("""{"type":"text","text":"{data:/title}"}"""),
          ),
      )
    val resolved = PrototypeDataResolver.resolveRoot(root, obj("""{"items":[],"title":"Feed"}"""))
    assertEquals(obj(list)["repeat"], resolved["repeat"])
    assertEquals(JsonPrimitive("Feed"), resolved.getValue("header").jsonObject["text"])
    assertEquals(JsonPrimitive("Feed"), resolved.getValue("footer").jsonObject["text"])
  }

  @Test
  fun `extend trims before array budget and failures leave input unchanged`() {
    val size = PrototypeSpecValidator.MAX_PROTOTYPE_DATA_ARRAY_ITEMS - 20
    val before = JsonObject(mapOf("items" to JsonArray((0 until size).map(::JsonPrimitive))))
    val incoming = JsonArray((size until size + 40).map(::JsonPrimitive))
    val result =
      PrototypeDataWriter.apply(before, PrototypeDataWrite.Extend("/data/items", incoming, 100))
        as PrototypeDataWriteResult.Success
    assertEquals(size - 60, result.trimmed)
    assertEquals(100, result.data.getValue("items").jsonArray.size)
    val failed =
      PrototypeDataWriter.apply(before, PrototypeDataWrite.Extend("/data/items", incoming))
        as PrototypeDataWriteResult.Failure
    assertEquals(PrototypeDataWriteErrorCode.LIMIT_EXCEEDED, failed.error.code)
    assertEquals(size, before.getValue("items").jsonArray.size)
  }

  @Test
  fun `strict events replay extend window and reject malformed payloads`() {
    val payload = obj("""{"op":"extend","value":[3,4],"maxItems":2,"revision":7}""")
    val event = checkNotNull(prototypeDataWriteOf("change", "/data/items", payload))
    assertEquals(payload, event.payload())
    val written =
      PrototypeDataWriter.apply(obj("""{"items":[1,2]}"""), checkNotNull(event.write()))
        as PrototypeDataWriteResult.Success
    assertEquals(obj("""{"items":[3,4]}"""), written.data)
    for (bad in
      listOf(
        """{"op":"extend","value":1,"revision":0}""",
        """{"op":"extend","value":[],"maxItems":0,"revision":0}""",
        """{"op":"append","value":1,"maxItems":1.5,"revision":0}""",
        """{"op":"extend","value":[],"revision":-1}""",
        """{"op":"extend","value":[],"revision":0,"unknown":1}""",
      )) assertNull(prototypeDataWriteOf("change", "/data/items", obj(bad)), bad)
    assertNull(prototypeDataWriteOf("emit", "/data/items", payload))
    assertNull(prototypeDataWriteOf("change", "/data", payload))
  }

  @Test
  fun `late row fields and stable identities use every projected row`() {
    val rows = JsonArray((0 until 200).map { obj("""{"id":$it,"title":"Row"}""") })
    val input = JsonObject(spec(obj(list), JsonObject(mapOf("items" to rows))))
    val decoded =
      (PrototypeSpecValidator.validate(input.toString()) as PrototypeSpecValidation.Success).spec
    val node = decoded.root as PrototypeListNode
    val items = PrototypeListRows.items(node, decoded.data)
    assertEquals("199", PrototypeListRows.key(node, items.last()))
    val duplicate = JsonArray(rows.dropLast(1) + rows.first())
    val invalid =
      PrototypeSpecValidator.validate(
        JsonObject(spec(obj(list), JsonObject(mapOf("items" to duplicate)))).toString(),
      ) as PrototypeSpecValidation.Failure
    assertEquals("root.repeat.key", invalid.error.path)
    assertEquals("Duplicate repeat key \"0\" (items 0 and 199)", invalid.error.message)
  }

  @Test
  fun `metadata refusal commits no append and successful completion reports writes in order`() {
    val before = obj("""{"items":[1],"page":{}}""")
    val response =
      PrototypeRequestResponse.Received(200, emptyMap(), obj("""{"items":[2],"next":"p2"}"""), 1)
    val append = PrototypeRequestAppend("/items", "/data/items")
    val committed = mutableListOf<PrototypeDataWrite>()
    var current = before
    fun commit(write: PrototypeDataWrite): PrototypeDataWriteError? {
      committed.add(write)
      val result = PrototypeDataWriter.apply(current, write) as PrototypeDataWriteResult.Success
      current = result.data
      return null
    }
    val failed =
      PrototypeRequestOutcome.complete(
        "/data/page",
        response,
        append,
        { writes ->
          if (
            writes.any {
              it.path == "/data/page__meta" &&
                (it as PrototypeDataWrite.Set).value.jsonObject["error"] == null
            }
          )
            PrototypeDataWriteError(PrototypeDataWriteErrorCode.LIMIT_EXCEEDED, "No metadata room")
          else PrototypeRequestOutcome.dataTrial(current, writes)
        },
        ::commit,
      )
    assertFalse(failed.succeeded)
    assertEquals(0, failed.appended)
    assertEquals(before["items"], current["items"])
    assertEquals(listOf("/data/page__meta"), committed.map { it.path })
    current = before
    committed.clear()
    val success =
      PrototypeRequestOutcome.complete(
        "/data/page",
        response,
        append,
        { PrototypeRequestOutcome.dataTrial(current, it) },
        ::commit,
      )
    assertTrue(success.succeeded)
    assertEquals(1, success.appended)
    assertEquals(listOf("extend", "set", "set"), committed.map { it.op })
    assertEquals(listOf("/data/items", "/data/page", "/data/page__meta"), committed.map { it.path })
  }

  @Test
  fun `extend events may omit the value when the page exceeds the event budget`() {
    val payload = obj("""{"op":"extend","maxItems":4,"revision":8}""")
    val event = checkNotNull(prototypeDataWriteOf("change", "/data/items", payload))
    assertEquals(payload, event.payload())
    assertNull(event.write())
    assertNull(
      prototypeDataWriteOf(
        "change",
        "/data/items",
        obj("""{"op":"extend","value":null,"revision":8}"""),
      ),
    )
  }

  @Test
  fun `paging maxItems must exceed the effective end threshold`() {
    for ((threshold, maximum) in listOf(null to 3, 2 to 2, 4 to 3)) {
      val root =
        JsonObject(
          obj(list) +
            buildJsonObject {
              put("onEndReached", JsonArray(listOf(obj("""{"type":"emit","name":"page"}"""))))
              put("maxItems", maximum)
              threshold?.let { put("endThreshold", it) }
            },
        )
      val result =
        PrototypeSpecValidator.validate(JsonObject(spec(root)).toString())
          as PrototypeSpecValidation.Failure
      assertEquals("root.maxItems", result.error.path)
      assertEquals("maxItems must be greater than endThreshold", result.error.message)
    }
  }

  @Test
  fun `missing and non scalar row keys never throw`() {
    val decoded =
      (PrototypeSpecValidator.validate(JsonObject(spec(obj(list))).toString())
          as PrototypeSpecValidation.Success)
        .spec
    val node = decoded.root as PrototypeListNode
    val missing = PrototypeListRows.key(node, obj("{}"), 0)
    val nested = PrototypeListRows.key(node, obj("""{"id":{}}"""), 1)
    val nullKey = PrototypeListRows.key(node, obj("""{"id":null}"""), 2)
    assertEquals(3, setOf(missing, nested, nullKey).size)
    assertNotEquals(PrototypeListRows.key(node, obj("""{"id":0}"""), 0), missing)
  }

  @Test
  fun `literal null append response fails without committing a page`() {
    val before = obj("""{"items":[],"page":"old"}""")
    val result =
      PrototypeRequestOutcome.apply(
        before,
        "/data/page",
        PrototypeRequestResponse.Received(200, emptyMap(), JsonNull, 0),
        PrototypeRequestAppend("/items", "/data/items"),
      )
    assertFalse(result.result.succeeded)
    assertEquals(PrototypeRequestErrorCode.INVALID_RESPONSE, result.result.meta.error!!.code)
    assertEquals(before["items"], result.data!!["items"])
    assertEquals(before["page"], result.data["page"])
  }

  companion object {
    @BeforeAll
    @JvmStatic
    fun prepareModels() {
      PrototypeSpecFixtures.loadFixtures()
      val data = Json.parseToJsonElement("""{"items":[],"page":{}}""").jsonObject
      PrototypeDataWriter.apply(
        data,
        PrototypeDataWrite.Extend("/data/items", JsonArray(emptyList()), 1),
      )
      PrototypeRequestOutcome.apply(
        data,
        "/data/page",
        PrototypeRequestResponse.Received(
          200,
          emptyMap(),
          Json.parseToJsonElement("""{"items":[]}"""),
          0,
        ),
        PrototypeRequestAppend("/items", "/data/items"),
      )
    }
  }
}
