package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.member
import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.strings
import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Located
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/**
 * Rules for the `cameraPreview` node (#14202) that the contract cannot express, the twin of
 * TypeScript's `prototypeCameraPreview.ts`: at most one per spec, an id that `camera.*` calls name
 * as `preview`, `camera` in `requires.platform` and `requires.permissions`, and lens, flash and
 * zoom keys that name declared state of the right type. Contract only: no runtime draws it.
 */
internal object PrototypeCameraPreview {
  private val previewCalls =
    setOf("camera.takePhoto", "camera.startRecording", "camera.stopRecording")

  private val stateKeys = listOf("lensKey" to false, "flashKey" to false, "zoomKey" to true)

  /** The ids of the spec's `cameraPreview` nodes, the values a `camera.*` `preview` may name. */
  fun ids(nodes: List<Located>): Set<String> =
    nodes
      .filter { it.value.text("type") == "cameraPreview" }
      .mapNotNull { it.value.text("id") }
      .toSet()

  /** The first `cameraPreview` node rule a spec breaks. */
  fun error(root: JsonObject, nodes: List<Located>): PrototypeSpecError? {
    val previews = nodes.filter { it.value.text("type") == "cameraPreview" }
    val requires = root.member("requires") ?: JsonObject(emptyMap())
    val camera = "camera" in requires.strings("platform")
    val permission =
      (requires["permissions"] as? JsonArray).orEmpty().any {
        (it as? JsonObject)?.text("name") == "camera"
      }
    val state = root.member("state").orEmpty()
    return previews.withIndex().firstNotNullOfOrNull { (index, located) ->
      if (index > 0) fail(located.path, "At most one cameraPreview per prototype")
      else nodeError(located.value, located.path, camera, permission, state)
    }
  }

  private fun nodeError(
    node: JsonObject,
    path: String,
    camera: Boolean,
    permission: Boolean,
    state: Map<String, JsonElement>,
  ): PrototypeSpecError? {
    val id = node.text("id")
    return when {
      !camera -> fail(path, "cameraPreview requires camera in requires.platform")
      !permission -> fail(path, "cameraPreview requires permission camera in requires.permissions")
      id == null || !PrototypeSpecValidator.stateKeyPattern.matches(id) ->
        fail(path, "A cameraPreview needs an id that is a state key")
      else ->
        stateKeys.firstNotNullOfOrNull { (field, number) ->
          node
            .text(field)
            ?.takeUnless {
              (state[it] as? JsonPrimitive)?.let { value -> isType(value, number) } == true
            }
            ?.let {
              fail(
                "$path.$field",
                "$field must name a declared ${if (number) "number" else "string"} state key",
              )
            }
        }
    }
  }

  private fun isType(value: JsonPrimitive, number: Boolean): Boolean =
    if (number) !value.isString && value.doubleOrNull != null else value.isString

  /**
   * A viewfinder `camera.*` call whose literal `preview` argument names no `cameraPreview` node.
   */
  fun callError(action: JsonObject, path: String, previews: Set<String>): PrototypeSpecError? {
    if (action.text("call") !in previewCalls) return null
    val preview = action.member("args")?.member("preview")?.text("value") ?: return null
    return if (preview in previews) null
    else fail("$path.args.preview.value", "Unknown camera preview")
  }
}
