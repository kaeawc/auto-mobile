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

  @Test
  fun `component roots contribute primary and fallback asset references`() {
    val spec =
      """{"id":"components","window":{"placement":{"type":"fullscreen"}},"root":{"type":"image","asset":"root"},"components":{"photo":{"root":{"type":"image","asset":{"light":"photo-light","dark":"photo-dark"},"placeholder":{"asset":"loading"},"error":{"asset":"failed"}}}}}"""
    assertEquals(
      setOf("root", "photo-light", "photo-dark", "loading", "failed"),
      PrototypeBundleSpec.references(spec.toByteArray()).images,
    )
  }

  @Test
  fun `screen named value requires remote capability without treating literals as nodes`() {
    val spec =
      Json.parseToJsonElement(
          """{"root":{"type":"stack","id":"nav","start":"value","screens":{"value":{"type":"image","url":"https://example.com/a"}}}}""",
        )
        .jsonObject
    assertEquals(
      true,
      PrototypeStrictPolicy.required(spec).contains(PrototypeRemoteImages.CAPABILITY),
    )
    val literal =
      Json.parseToJsonElement(
          """{"root":{"type":"text","text":"safe","onTap":[{"type":"emit","name":"safe","payload":{"value":{"type":"image","url":"https://example.com/a"}}}]}}""",
        )
        .jsonObject
    assertEquals(
      false,
      PrototypeStrictPolicy.required(literal).contains(PrototypeRemoteImages.CAPABILITY),
    )
  }

  @Test
  fun `state and platform scans skip consumed binding spans`() {
    for (text in listOf("{data:/photos/{cover}", "{platform:/device/{cover}")) {
      assertEquals(
        emptyList<String>(),
        PrototypeDataText.pointers(text, "", PrototypeRepeatTemplate::isFieldName),
      )
    }
    assertEquals(
      emptyList<String>(),
      PrototypeDataText.pointers("{data:/photos/{platform:/device/os}", "platform"),
    )
    assertEquals(
      listOf("/device/os"),
      PrototypeDataText.pointers("{data:/photos/a}{platform:/device/os}", "platform"),
    )
    assertEquals(
      listOf("cover"),
      PrototypeDataText.pointers(
        "{data:/photos/a}{cover}",
        "",
        PrototypeRepeatTemplate::isFieldName,
      ),
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
        val refused =
          PrototypeSpecValidator.validate(spec.toString(), supportedCapabilities = emptySet())
        assertEquals(true, refused is PrototypeSpecValidation.Failure)
        assertEquals(
          true,
          (refused as PrototypeSpecValidation.Failure)
            .error
            .message
            .contains(PrototypeRemoteImages.CAPABILITY),
        )
        assertEquals(
          true,
          PrototypeSpecValidator.validate(
            spec.toString(),
            supportedCapabilities = setOf(PrototypeRemoteImages.CAPABILITY),
          ) is PrototypeSpecValidation.Success,
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
        val spec = fixture.getValue("spec")
        val result = PrototypeSpecValidator.validate(spec.toString())
        if (fixture.getValue("name").jsonPrimitive.content == "accessory-https") {
          val supported = setOf("prototype_platform_namespace_v1", PrototypeRemoteImages.CAPABILITY)
          assertEquals(
            true,
            PrototypeSpecValidator.validate(spec.toString(), supportedCapabilities = supported)
              is PrototypeSpecValidation.Success,
          )
          val refused =
            PrototypeSpecValidator.validate(
              spec.toString(),
              supportedCapabilities = supported - PrototypeRemoteImages.CAPABILITY,
            )
          assertEquals(true, refused is PrototypeSpecValidation.Failure)
          assertEquals(
            true,
            (refused as PrototypeSpecValidation.Failure)
              .error
              .message
              .contains(PrototypeRemoteImages.CAPABILITY),
          )
        }
        assertEquals(
          fixture.getValue("valid").jsonPrimitive.boolean,
          result is PrototypeSpecValidation.Success,
          result.toString(),
        )
      }
    }
  }
}
