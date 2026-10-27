package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory

class PrototypeListWritesTest {
  private fun fixtures(name: String): JsonArray =
    Json.parseToJsonElement(File(fixtureDirectory(), "list-writes/$name.json").readText()).jsonArray

  @TestFactory
  fun dataWrites(): List<DynamicTest> =
    fixtures("data-writes").map { raw ->
      val fixture = raw.jsonObject
      DynamicTest.dynamicTest(fixture.getValue("name").jsonPrimitive.content) {
        val write = fixture.getValue("write").jsonObject
        val path = write.getValue("path").jsonPrimitive.content
        val value = write["value"] ?: JsonNull
        val maxItems = write["maxItems"]?.jsonPrimitive?.double
        val input =
          when (write.getValue("op").jsonPrimitive.content) {
            "append" -> PrototypeDataWrite.Append(path, value, maxItems)
            "prepend" -> PrototypeDataWrite.Prepend(path, value, maxItems)
            "extend" -> PrototypeDataWrite.Extend(path, value, maxItems)
            "set" -> PrototypeDataWrite.Set(path, value)
            "remove" -> PrototypeDataWrite.Remove(path)
            else -> error("Unknown fixture op")
          }
        val expected = fixture.getValue("expected").jsonObject
        when (
          val result = PrototypeDataWriter.apply(fixture.getValue("before").jsonObject, input)
        ) {
          is PrototypeDataWriteResult.Success -> {
            assertEquals(expected["data"], result.data)
            assertEquals(expected.getValue("trimmed").jsonPrimitive.int, result.trimmed)
          }
          is PrototypeDataWriteResult.Failure ->
            assertEquals(expected["errorCode"]?.jsonPrimitive?.content, result.error.code.wireValue)
        }
      }
    }

  @TestFactory
  fun requestOutcomes(): List<DynamicTest> =
    fixtures("request-outcomes").map { raw ->
      val fixture = raw.jsonObject
      DynamicTest.dynamicTest(fixture.getValue("name").jsonPrimitive.content) {
        val response = fixture.getValue("response").jsonObject
        val duration = response.getValue("durationMs").jsonPrimitive.long
        val message =
          if (response.getValue("ok").jsonPrimitive.boolean)
            PrototypeRequestResponse.Received(
              response.getValue("status").jsonPrimitive.int,
              response.getValue("headers").jsonObject.mapValues { it.value.jsonPrimitive.content },
              // The shared transport fixtures model an empty HTTP body as JSON null.
              response["body"]?.takeUnless { it is JsonNull },
              duration,
            )
          else {
            val error = response.getValue("error").jsonObject
            PrototypeRequestResponse.Failed(
              PrototypeRequestError(
                PrototypeRequestErrorCode.entries.first {
                  it.wireValue == error.getValue("code").jsonPrimitive.content
                },
                error.getValue("message").jsonPrimitive.content,
              ),
              duration,
            )
          }
        val append = fixture.getValue("append").jsonObject
        val result =
          PrototypeRequestOutcome.apply(
            fixture.getValue("before").jsonObject,
            fixture["into"]?.takeUnless { it is JsonNull }?.jsonPrimitive?.content,
            message,
            PrototypeRequestAppend(
              append.getValue("from").jsonPrimitive.content,
              append.getValue("to").jsonPrimitive.content,
              append["maxItems"]?.jsonPrimitive?.long,
            ),
          )
        val expected = fixture.getValue("expected").jsonObject
        assertEquals(expected["data"], result.data)
        assertEquals(expected["meta"], result.result.meta.toJson())
        assertEquals(
          expected.getValue("status").jsonPrimitive.content == "success",
          result.result.succeeded,
        )
        assertEquals(expected.getValue("wroteInto").jsonPrimitive.boolean, result.result.wroteInto)
        assertEquals(expected.getValue("appended").jsonPrimitive.int, result.result.appended)
      }
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
