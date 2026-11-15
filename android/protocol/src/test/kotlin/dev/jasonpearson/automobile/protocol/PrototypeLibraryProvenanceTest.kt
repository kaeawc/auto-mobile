package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlin.test.assertEquals
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Test

/** R6: the sensitive modules ProtoViewer's provenance region names, from the R1 fixtures. */
class PrototypeLibraryProvenanceTest {
  private fun fixture(name: String): String =
    Json.parseToJsonElement(File(File(fixtureDirectory(), "library-modules"), name).readText())
      .jsonObject
      .getValue("spec")
      .toString()

  @Test
  fun `refused fixtures name the module of their sensitive call or handler`() {
    assertEquals(
      listOf("clipboard"),
      PrototypeLibraryProvenance.sensitiveModules(fixture("call-clipboard-paste.json")),
    )
    assertEquals(
      listOf("share"),
      PrototypeLibraryProvenance.sensitiveModules(fixture("call-share-open.json")),
    )
    assertEquals(
      listOf("test"),
      PrototypeLibraryProvenance.sensitiveModules(fixture("call-test-protected.json")),
    )
    assertEquals(
      listOf("notifications"),
      PrototypeLibraryProvenance.sensitiveModules(fixture("event-notifications-reply.json")),
    )
  }

  @Test
  fun `non-sensitive modules and malformed data name nothing`() {
    val accepted =
      listOf("valid-device-changed.json", "valid-haptics-perform.json", "valid-sound-play.json")
    for (name in accepted) {
      assertEquals(emptyList(), PrototypeLibraryProvenance.sensitiveModules(fixture(name)), name)
    }
    assertEquals(emptyList(), PrototypeLibraryProvenance.sensitiveModules("not json"))
  }

  @Test
  fun `a paste button and a share call name both modules once, sorted`() {
    val spec =
      """{"root":{"type":"column","children":[
        {"type":"pasteButton","into":"/data/a"},
        {"type":"button","label":"S","onTap":[{"type":"platform","call":"share.open"},
          {"type":"platform","call":"clipboard.paste"}]}]}}"""
    assertEquals(listOf("clipboard", "share"), PrototypeLibraryProvenance.sensitiveModules(spec))
  }
}
