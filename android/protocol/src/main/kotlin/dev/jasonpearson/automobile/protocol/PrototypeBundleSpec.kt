package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeBundleErrorCode.*
import dev.jasonpearson.automobile.protocol.PrototypeBundleManifestCodec.text
import kotlinx.serialization.json.*

internal data class PrototypeBundleReferences(
  val images: Set<String>,
  val fonts: Set<String>,
  val spec: JsonObject,
  val context: PrototypeStateChecks.Context,
)

internal object PrototypeBundleSpec {
  fun references(bytes: ByteArray): PrototypeBundleReferences {
    val value = PrototypeBundleJson.parse(bytes, spec_invalid_json, "spec.json")
    val context = PrototypeStateChecks.Context()
    bundleRequire(
      PrototypeSpecInput.validateInput(value.toString(), context)
        is PrototypeSpecValidation.Success,
      spec_invalid,
      "spec.json",
    )
    val spec = value as JsonObject
    val images = linkedSetOf<String>()
    val fonts = linkedSetOf<String>()
    for (node in nodes(spec)) {
      if (text(node["type"]) == "image") addImage(node["asset"], images)
      for (item in (node["items"] as? JsonArray).orEmpty()) addImage(
        (item as? JsonObject)?.get("image"),
        images,
      )
      addFont(node["style"], fonts)
      for (entry in (node["styleWhen"] as? JsonArray).orEmpty()) addFont(
        (entry as? JsonObject)?.get("style"),
        fonts,
      )
      for (span in (node["spans"] as? JsonArray).orEmpty()) addFont(
        (span as? JsonObject)?.get("style"),
        fonts,
      )
    }
    return PrototypeBundleReferences(images, fonts, spec, context)
  }

  // Reuse protocol's structural node traversal; opaque data/state/action bodies are not nodes.
  fun nodes(spec: JsonObject): Sequence<JsonObject> =
    (spec["root"] as? JsonObject)
      ?.let { PrototypePatchNodes.tree(it, emptyList(), "root").map { entry -> entry.node } }
      .orEmpty()

  private fun addImage(value: JsonElement?, images: MutableSet<String>) {
    text(value)?.let { images.add(it) }
    if (value is JsonObject) {
      addImage(value["light"], images)
      addImage(value["dark"], images)
    }
  }

  private fun addFont(value: JsonElement?, fonts: MutableSet<String>) {
    text(((value as? JsonObject)?.get("fontFamily") as? JsonObject)?.get("asset"))?.let {
      fonts.add(it)
    }
  }
}
