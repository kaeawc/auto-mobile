package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class PrototypeInboundRuntimeModelTest {
  private val json = Json { classDiscriminator = "type" }

  @Test
  fun `inbound table and capability survive typed round trips`() {
    val raw = File(fixtureDirectory(), "valid/links-routes.json").readText()
    val result = PrototypeSpecValidator.validate(raw)
    assertTrue(result is PrototypeSpecValidation.Success, result.toString())
    val spec = (result as PrototypeSpecValidation.Success).spec
    assertEquals(listOf("prototype_links_v1"), spec.requires!!.capabilities)
    assertEquals(Json.parseToJsonElement(raw).jsonObject["links"], spec.links)
    val encoded = json.encodeToString(PrototypeSpec.serializer(), spec)
    val revalidated = PrototypeSpecValidator.validate(encoded)
    assertTrue(revalidated is PrototypeSpecValidation.Success, revalidated.toString())
    assertEquals(spec, (revalidated as PrototypeSpecValidation.Success).spec)
  }

  @Test
  fun `platform requirements keep their object representation`() {
    val block = PrototypeRequires(platform = listOf("device"))
    val encoded = json.encodeToJsonElement(PrototypeRequiresSerializer, block)
    assertEquals(
      buildJsonObject { put("platform", JsonArray(listOf(JsonPrimitive("device")))) },
      encoded,
    )
    assertEquals(block, json.decodeFromJsonElement(PrototypeRequiresSerializer, encoded))
    val defaults = Json {
      encodeDefaults = true
      explicitNulls = false
    }
    assertEquals(encoded, defaults.encodeToJsonElement(PrototypeRequiresSerializer, block))
  }

  @Test
  fun `links and platform requirements survive validation and typed round trips`() {
    val raw = File(fixtureDirectory(), "valid/links-platform.json").readText()
    val result = PrototypeSpecValidator.validate(raw)
    assertTrue(result is PrototypeSpecValidation.Success, result.toString())
    val spec = (result as PrototypeSpecValidation.Success).spec
    assertEquals(listOf("prototype_links_v1"), spec.requires!!.capabilities)
    assertEquals(listOf("location"), spec.requires!!.platform)
    val encoded = json.encodeToString(PrototypeSpec.serializer(), spec)
    val block = Json.parseToJsonElement(encoded).jsonObject["requires"]!!.jsonObject
    assertEquals(JsonArray(listOf(JsonPrimitive("prototype_links_v1"))), block["capabilities"])
    val revalidated = PrototypeSpecValidator.validate(encoded)
    assertTrue(revalidated is PrototypeSpecValidation.Success, revalidated.toString())
    assertEquals(spec, (revalidated as PrototypeSpecValidation.Success).spec)
    val root = Json.parseToJsonElement(raw).jsonObject
    val required = PrototypeStrictPolicy.required(root)
    assertTrue("prototype_links_v1" in required)
    val unsupported = PrototypeSpecValidator.validate(raw, required - "prototype_links_v1")
    assertTrue(unsupported is PrototypeSpecValidation.Failure, unsupported.toString())
    assertEquals(
      PrototypeSpecError("$", "Unsupported capabilities: prototype_links_v1"),
      (unsupported as PrototypeSpecValidation.Failure).error,
    )
    assertTrue(PrototypeSpecValidator.validate(raw, required) is PrototypeSpecValidation.Success)
    val missing =
      JsonObject(root + ("requires" to JsonObject(root["requires"]!!.jsonObject - "capabilities")))
    val rejected = PrototypeSpecValidator.validate(missing.toString())
    assertTrue(rejected is PrototypeSpecValidation.Failure, rejected.toString())
    assertEquals(
      "links requires prototype_links_v1",
      (rejected as PrototypeSpecValidation.Failure).error.message,
    )
  }

  @Test
  fun `explicit capability extraction handles both requires forms including unknown names`() {
    val capabilities = JsonArray(listOf(JsonPrimitive("prototype_future_v1")))
    for (requires in listOf(capabilities, buildJsonObject { put("capabilities", capabilities) })) {
      val root = buildJsonObject { put("requires", requires) }
      assertTrue("prototype_future_v1" in PrototypeStrictPolicy.required(root))
    }
  }
}
