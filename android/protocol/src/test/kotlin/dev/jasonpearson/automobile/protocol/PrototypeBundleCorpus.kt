package dev.jasonpearson.automobile.protocol

import java.io.File
import java.util.Base64
import kotlinx.serialization.json.*

internal object PrototypeBundleCorpus {
  data class Case(val value: JsonObject, val bytes: ByteArray) {
    val name = value.getValue("name").jsonPrimitive.content
    val accepted = value.getValue("expect").jsonPrimitive.content == "accept"
  }

  val root: JsonObject by lazy {
    val relative = "test/fixtures/prototype-bundle/corpus.json"
    val file =
      sequenceOf(File(relative), File("../$relative"), File("../../$relative")).first { it.isFile }
    Json.parseToJsonElement(file.readText()).jsonObject
  }
  val cases: List<Case> by lazy {
    root
      .getValue("cases")
      .jsonArray
      .map { it.jsonObject }
      .map { Case(it, decode(it.getValue("bundleBase64"))) }
  }

  fun decode(value: JsonElement): ByteArray =
    Base64.getDecoder().decode(value.jsonPrimitive.content)

  fun input(value: JsonObject): PrototypeBundleExportInput {
    fun assets(key: String): Map<String, PrototypeBundleAsset> =
      value.getValue(key).jsonArray.associate {
        val obj = it.jsonObject
        obj.getValue("id").jsonPrimitive.content to
          PrototypeBundleAsset(
            obj.getValue("mediaType").jsonPrimitive.content,
            decode(obj.getValue("base64")),
          )
      }
    val images = assets("assets")
    val fonts = assets("fonts")
    return PrototypeBundleExportInput(decode(value.getValue("specBase64")), images::get, fonts::get)
  }
}
