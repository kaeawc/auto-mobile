package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory

class PrototypeLinkResolverTest {
  @TestFactory
  fun sharedVectors(): List<DynamicTest> {
    val vectors =
      Json.parseToJsonElement(File(fixtureDirectory(), "links/resolver-vectors.json").readText())
        .jsonObject
    val table =
      vectors.getValue("table").jsonArray.map {
        PrototypeLinkMatcher.Entry(it.jsonObject.getValue("path").jsonPrimitive.content)
      }
    return vectors.getValue("cases").jsonArray.map { raw ->
      val vector = raw.jsonObject
      val url = vector.getValue("url").jsonPrimitive.content
      DynamicTest.dynamicTest(url) {
        val registration = vector.getValue("registration").jsonObject
        val match =
          PrototypeLinkResolver.resolve(
            url,
            PrototypeLinkResolver.Registration(
              registration.getValue("schemes").jsonArray.map { it.jsonPrimitive.content },
              registration.getValue("web").jsonArray.map {
                PrototypeLinkResolver.Web(
                  it.jsonObject.getValue("scheme").jsonPrimitive.content,
                  it.jsonObject.getValue("host").jsonPrimitive.content,
                )
              },
            ),
            table,
          )
        val actual =
          match?.let {
            buildJsonObject {
              put("entryIndex", it.entryIndex)
              put(
                "captures",
                JsonObject(it.captures.mapValues { (_, value) -> JsonPrimitive(value) }),
              )
              put("query", JsonObject(it.query))
            }
          } ?: JsonNull
        assertEquals(vector.getValue("expected"), actual)
      }
    }
  }
}
