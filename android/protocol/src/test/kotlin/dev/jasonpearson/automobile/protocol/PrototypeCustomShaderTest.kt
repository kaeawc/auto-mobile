package dev.jasonpearson.automobile.protocol

import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Test

class PrototypeCustomShaderTest {
  private val spec =
    """{"id":"shader","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Effect","style":{"shader":{"asset":"effect","uniforms":{"strength":1}}}}}"""

  @Test
  fun `shader model retains uniforms and requires the negotiated capability`() {
    val accepted = assertIs<PrototypeSpecValidation.Success>(PrototypeSpecValidator.validate(spec))
    assertEquals("effect", accepted.spec.root.style?.shader?.asset)
    assertEquals(mapOf("strength" to 1.0), accepted.spec.root.style?.shader?.uniforms)
    val required = PrototypeStrictPolicy.required(Json.parseToJsonElement(spec).jsonObject)
    assertEquals(setOf("prototype_custom_shaders_v1"), required)
    assertIs<PrototypeSpecValidation.Failure>(PrototypeSpecValidator.validate(spec, emptySet()))
    assertIs<PrototypeSpecValidation.Success>(PrototypeSpecValidator.validate(spec, required))
  }

  @Test
  fun `rich text span styles do not accept shaders`() {
    val richText =
      """{"id":"shader","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","spans":[{"text":"Effect","style":{"shader":{"asset":"effect"}}}]}}"""
    assertIs<PrototypeSpecValidation.Failure>(PrototypeSpecValidator.validate(richText))
  }

  @Test
  fun `bundle path explicitly refuses shader spec and MIME`() {
    val failure =
      org.junit.jupiter.api.assertThrows<PrototypeBundleFailure> {
        PrototypeBundleSpec.references(spec.toByteArray())
      }
    assertEquals(PrototypeBundleErrorCode.custom_shaders_unsupported, failure.code)
    assertTrue(failure.message.orEmpty().contains("ProtoViewer bundles refuse"))
    val manifest =
      """{"bundleFormatVersion":1,"specSha256":"${"0".repeat(64)}","assets":[{"id":"effect","file":"assets/effect.agsl","sha256":"${"0".repeat(64)}","mediaType":"application/vnd.automobile.agsl"}],"fonts":[],"requires":[]}"""
    val mime =
      org.junit.jupiter.api.assertThrows<PrototypeBundleFailure> {
        PrototypeBundleManifestCodec.parse(manifest.toByteArray())
      }
    assertEquals(PrototypeBundleErrorCode.custom_shaders_unsupported, mime.code)
  }
}
