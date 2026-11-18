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
  }
}
