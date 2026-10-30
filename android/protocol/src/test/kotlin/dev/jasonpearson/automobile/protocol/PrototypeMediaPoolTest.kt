package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeMediaPool.Allocation
import dev.jasonpearson.automobile.protocol.PrototypeMediaPool.Input
import dev.jasonpearson.automobile.protocol.PrototypeMediaPool.Item
import dev.jasonpearson.automobile.protocol.PrototypeMediaPool.Mode
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PrototypeMediaPoolTest {
  private val cases: List<JsonObject> by lazy {
    val fixture =
      generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
        .map { File(it, "test/fixtures/prototype-media-pool/allocation.json") }
        .first { it.isFile }
    Json.parseToJsonElement(fixture.readText()).jsonArray.map { it.jsonObject }
  }

  private fun input(json: JsonObject) =
    Input(
      mode = if (json.getValue("mode").jsonPrimitive.content == "pager") Mode.PAGER else Mode.LIST,
      items =
        json.getValue("items").jsonArray.map {
          val item = it.jsonObject
          Item(
            item.getValue("id").jsonPrimitive.content,
            item.getValue("visibleFraction").jsonPrimitive.double,
          )
        },
      settledIndex = json["settledIndex"]?.jsonPrimitive?.intOrNull,
      visibleThreshold = json.getValue("visibleThreshold").jsonPrimitive.double,
      foreground = json.getValue("foreground").jsonPrimitive.boolean,
      held = json.getValue("held").jsonArray.map { it.jsonPrimitive.content },
    )

  private fun allocation(json: JsonObject) =
    Allocation(
      play = json.getValue("play").jsonPrimitive.contentOrNull,
      preload = json.getValue("preload").jsonArray.map { it.jsonPrimitive.content },
      release = json.getValue("release").jsonArray.map { it.jsonPrimitive.content },
    )

  @Test
  fun `shared fixtures allocate the same players on every platform`() {
    assertTrue(cases.isNotEmpty())
    for (case in cases) {
      val name = case.getValue("name").jsonPrimitive.content
      assertEquals(
        name,
        allocation(case.getValue("expected").jsonObject),
        PrototypeMediaPool.allocate(input(case.getValue("input").jsonObject)),
      )
    }
  }

  @Test
  fun `the pool size comes from the contract`() {
    assertEquals(
      PrototypeSpecContract.limits.getValue("MAX_PROTOTYPE_ACTIVE_DECODERS").jsonPrimitive.int,
      PrototypeMediaPool.MAX_PROTOTYPE_ACTIVE_DECODERS,
    )
  }

  @Test
  fun `swiping fifty pages never holds more than the pool and always plays one page`() {
    val pages = List(50) { "p$it" }
    val held = mutableListOf<String>()
    for (page in pages.indices) {
      val result =
        PrototypeMediaPool.allocate(
          Input(
            mode = Mode.PAGER,
            items = pages.mapIndexed { index, id -> Item(id, if (index == page) 1.0 else 0.0) },
            settledIndex = page,
            held = held.toList(),
          ),
        )
      held.removeAll(result.release.toSet())
      (listOfNotNull(result.play) + result.preload).filterNot(held::contains).forEach(held::add)
      assertEquals(pages[page], result.play)
      assertTrue(
        "page $page holds $held",
        held.size <= PrototypeMediaPool.MAX_PROTOTYPE_ACTIVE_DECODERS,
      )
    }
  }
}
