package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.descriptors.PolymorphicKind
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.SerialKind
import kotlinx.serialization.descriptors.StructureKind
import kotlinx.serialization.descriptors.elementDescriptors
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Test

/** Describes the actual serializers without constructing production messages or sampling clocks. */
@OptIn(ExperimentalSerializationApi::class)
class WireContractFixtureTest {
  @Test
  fun wireContractFixture() {
    val requests =
      WebSocketRequest.serializer().descriptor.getElementDescriptor(1).elementDescriptors.sortedBy {
        it.serialName
      }
    val responses =
      WebSocketResponse.serializer()
        .descriptor
        .getElementDescriptor(1)
        .elementDescriptors
        .sortedBy { it.serialName }
    assertTrue(requests.size >= 60, "Expected at least 60 request serializers")
    assertTrue(responses.size >= 55, "Expected at least 55 response serializers")
    val roots = (requests + responses).map { it.serialName }.toSet()
    val visited = mutableSetOf<String>()
    val nested = sortedMapOf<String, JsonElement>()

    fun collect(descriptor: SerialDescriptor) {
      val serialName = descriptor.serialName.removeSuffix("?")
      if (isJson(descriptor)) return
      when (descriptor.kind) {
        StructureKind.CLASS -> {
          if (!visited.add(serialName)) return
          if (serialName !in roots) nested[serialName] = fields(descriptor)
          descriptor.elementDescriptors.forEach(::collect)
        }
        // Generic containers share serial names; visit each occurrence to retain every value type.
        StructureKind.LIST,
        StructureKind.MAP -> descriptor.elementDescriptors.forEach(::collect)
        PolymorphicKind.SEALED -> {
          if (!visited.add(serialName)) return
          descriptor.getElementDescriptor(1).elementDescriptors.forEach(::collect)
        }
        else -> Unit // Contextual/open-polymorphic values have no statically known children.
      }
    }
    (requests + responses).forEach(::collect)
    val fixture = buildJsonObject {
      put("requests", JsonArray(requests.map(::message)))
      put("responses", JsonArray(responses.map(::message)))
      put("nestedTypes", JsonObject(nested))
    }
    val json = Json {
      prettyPrint = true
      prettyPrintIndent = "  "
    }
    val generated = json.encodeToString(JsonElement.serializer(), fixture) + "\n"
    val output = System.getenv("AUTOMOBILE_FIXTURE_OUT_DIR")
    if (output != null) {
      val directory = File(output)
      directory.mkdirs()
      File(directory, "android-wire-contract.json").writeText(generated, Charsets.UTF_8)
    } else {
      val relative = "test/fixtures/android-contract/android-wire-contract.json"
      val committed =
        generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) {
            it.parentFile
          }
          .map { File(it, relative) }
          .firstOrNull { it.isFile }
      val regenerate =
        "Regenerate: cd android && AUTOMOBILE_FIXTURE_OUT_DIR=\$PWD/../test/fixtures/android-contract ./gradlew :protocol:test --tests '*WireContractFixtureTest*'"
      assertTrue(committed != null, "Could not locate $relative. $regenerate")
      assertEquals(committed.readText(Charsets.UTF_8), generated, regenerate)
    }
  }

  private fun message(descriptor: SerialDescriptor): JsonObject = buildJsonObject {
    put("serialName", descriptor.serialName)
    put("fields", fields(descriptor))
  }

  private fun fields(descriptor: SerialDescriptor): JsonArray =
    JsonArray(
      (0 until descriptor.elementsCount).map { index ->
        val element = descriptor.getElementDescriptor(index)
        buildJsonObject {
          put("name", descriptor.getElementName(index))
          put("type", kind(element))
          put("nullable", element.isNullable)
          put("hasDefault", descriptor.isElementOptional(index))
        }
      },
    )

  private fun isJson(descriptor: SerialDescriptor): Boolean =
    descriptor.serialName.startsWith("kotlinx.serialization.json.")

  private fun kind(descriptor: SerialDescriptor): String {
    if (isJson(descriptor)) return "json"
    return when (descriptor.kind) {
      PrimitiveKind.STRING,
      PrimitiveKind.CHAR -> "string"
      PrimitiveKind.BYTE,
      PrimitiveKind.SHORT,
      PrimitiveKind.INT -> "int"
      PrimitiveKind.LONG -> "long"
      PrimitiveKind.FLOAT,
      PrimitiveKind.DOUBLE -> "double"
      PrimitiveKind.BOOLEAN -> "boolean"
      StructureKind.LIST -> "list"
      StructureKind.MAP -> "map"
      SerialKind.ENUM -> "enum"
      StructureKind.CLASS,
      StructureKind.OBJECT -> "object:${descriptor.serialName.removeSuffix("?")}"
      PolymorphicKind.SEALED,
      PolymorphicKind.OPEN -> "polymorphic"
      else -> "json"
    }
  }
}
