package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

class PrototypeRemoteImagesTest {
  companion object {
    @BeforeAll
    @JvmStatic
    fun loadContract() {
      check(PrototypeSpecContract.definitions.isNotEmpty())
    }
  }

  @Test
  fun `fallback references capability refusal and canonical limits`() {
    val cases =
      Json.parseToJsonElement(File(fixtureDirectory(), "remote-images.json").readText()).jsonArray
    val spec =
      cases
        .first { it.jsonObject.getValue("name").jsonPrimitive.content == "static" }
        .jsonObject
        .getValue("spec")
    val refs = PrototypeBundleSpec.references(spec.toString().toByteArray())
    assertEquals(setOf("loading"), refs.images)
    assertEquals(
      true,
      PrototypeBundleCapabilities.required(refs).contains(PrototypeRemoteImages.CAPABILITY),
    )
    assertEquals(
      true,
      PrototypeSpecValidator.validate(spec.toString(), supportedCapabilities = emptySet())
        is PrototypeSpecValidation.Failure,
    )
    val limits =
      mapOf(
        "MAX_PROTOTYPE_REMOTE_IMAGE_URL_LENGTH" to
          PrototypeRemoteImages.MAX_PROTOTYPE_REMOTE_IMAGE_URL_LENGTH,
        "MAX_PROTOTYPE_REMOTE_IMAGE_DOWNLOAD_BYTES" to
          PrototypeRemoteImages.MAX_PROTOTYPE_REMOTE_IMAGE_DOWNLOAD_BYTES,
        "PROTOTYPE_REMOTE_IMAGE_ANDROID_HEAP_DIVISOR" to
          PrototypeRemoteImages.PROTOTYPE_REMOTE_IMAGE_ANDROID_HEAP_DIVISOR,
        "MAX_PROTOTYPE_REMOTE_IMAGE_IOS_MEMORY_BYTES" to
          PrototypeRemoteImages.MAX_PROTOTYPE_REMOTE_IMAGE_IOS_MEMORY_BYTES,
        "MAX_PROTOTYPE_REMOTE_IMAGE_DISK_BYTES" to
          PrototypeRemoteImages.MAX_PROTOTYPE_REMOTE_IMAGE_DISK_BYTES,
        "MAX_PROTOTYPE_REMOTE_IMAGE_LOADS" to
          PrototypeRemoteImages.MAX_PROTOTYPE_REMOTE_IMAGE_LOADS,
      )
    for ((name, value) in limits) assertEquals(
      PrototypeSpecContract.limits.getValue(name).jsonPrimitive.int,
      value,
    )
  }

  @TestFactory
  fun capabilityFields(): List<DynamicTest> {
    val fields =
      mapOf(
        "url" to JsonPrimitive("https://example.com/a"),
        "placeholder" to buildJsonObject { put("asset", "loading") },
        "error" to buildJsonObject { put("color", "#123456") },
        "crossfade" to JsonPrimitive(false),
        "via" to JsonPrimitive("device"),
      )
    return fields.map { (field, value) ->
      DynamicTest.dynamicTest("capability for image.$field") {
        val spec = buildJsonObject {
          put("id", "remote")
          put(
            "window",
            buildJsonObject { put("placement", buildJsonObject { put("type", "fullscreen") }) },
          )
          put(
            "root",
            buildJsonObject {
              put("type", "image")
              if (field != "url") put("asset", "photo")
              put(field, value)
            },
          )
        }
        assertEquals(setOf(PrototypeRemoteImages.CAPABILITY), PrototypeStrictPolicy.required(spec))
        val refs = PrototypeBundleSpec.references(spec.toString().toByteArray())
        assertEquals(
          listOf(PrototypeRemoteImages.CAPABILITY),
          PrototypeBundleCapabilities.required(refs),
        )
        assertEquals(
          true,
          PrototypeSpecValidator.validate(spec.toString()) is PrototypeSpecValidation.Success,
        )
        assertEquals(
          true,
          PrototypeSpecValidator.validate(spec.toString(), supportedCapabilities = emptySet())
            is PrototypeSpecValidation.Failure,
        )
      }
    }
  }

  @TestFactory
  fun sharedContract(): List<DynamicTest> {
    val cases =
      Json.parseToJsonElement(File(fixtureDirectory(), "remote-images.json").readText()).jsonArray
    return cases.map { raw ->
      val fixture = raw.jsonObject
      DynamicTest.dynamicTest(fixture.getValue("name").jsonPrimitive.content) {
        val result = PrototypeSpecValidator.validate(fixture.getValue("spec").toString())
        assertEquals(
          fixture.getValue("valid").jsonPrimitive.boolean,
          result is PrototypeSpecValidation.Success,
          result.toString(),
        )
      }
    }
  }
}
