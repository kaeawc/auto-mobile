package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.member
import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.keyPath
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Every platform call, handler, `/platform` read and `{event}` reference in a spec (#14294). */
internal object PrototypePlatformUses {
  sealed class Use(val path: String) {
    class Handler(path: String, val event: String) : Use(path)

    class Call(path: String, val action: JsonObject) : Use(path)

    class Read(path: String, val pointer: String, val condition: JsonObject? = null) : Use(path)

    class Event(path: String, val inHandler: Boolean) : Use(path)
  }

  /** Handlers, then the scan of each node root, then text placeholders: TypeScript's order. */
  fun uses(root: JsonObject, context: Context): List<Use> {
    val found = mutableListOf<Use>()
    val handlers = root.member("platform")?.member("on").orEmpty()
    for ((event, handler) in handlers.entries.sortedBy { it.key }) {
      val at = "platform.on[${PrototypeSpecInput.canonicalString(event)}]"
      found.add(Use.Handler(at, event))
      scan(handler, at, true, found)
    }
    root["root"]?.let { scan(it, "root", false, found) }
    for ((node, path) in context.nodes) {
      PrototypeBindableFields.first(node, path) { field, at, kind ->
        if (kind == PrototypeBindableKind.TEXT) {
          val text = (field as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.content
          text?.let(::placeholders)?.forEach { found.add(Use.Read(at, it)) }
        }
        null
      }
    }
    return found
  }

  /** Emit payloads and literal repeat items are data; a `{value}` binding's literal is opaque. */
  private val opaqueKeys = setOf("payload", "repeat")

  private fun scan(value: JsonElement, path: String, inHandler: Boolean, found: MutableList<Use>) {
    when (value) {
      is JsonArray ->
        value.forEachIndexed { index, child -> scan(child, "$path[$index]", inHandler, found) }
      is JsonObject -> scanObject(value, path, inHandler, found)
      else -> Unit
    }
  }

  /** A `pasteButton` node runs `clipboard.paste` into its `into` path. */
  private fun addPasteButtonUse(value: JsonObject, path: String, found: MutableList<Use>) {
    if (value.text("type") != "pasteButton") return
    found.add(
      Use.Call(
        path,
        JsonObject(
          mapOf(
            "call" to JsonPrimitive("clipboard.paste"),
            "into" to (value["into"] ?: JsonNull),
          ),
        ),
      ),
    )
  }

  private fun scanObject(
    value: JsonObject,
    path: String,
    inHandler: Boolean,
    found: MutableList<Use>,
  ) {
    if (value.size == 1 && value.containsKey("value")) return
    addPasteButtonUse(value, path, found)
    if (value.text("type") == "platform" && value.text("call") != null) {
      found.add(Use.Call(path, value))
    }
    if (value["type"] == null) {
      value.text("platform")?.let { found.add(Use.Read("$path.platform", it, value)) }
      if (value.text("event") != null) found.add(Use.Event("$path.event", inHandler))
    }
    for (key in value.keys.sorted()) {
      val screens = if (key == "screens") value[key] as? JsonObject else null
      if (screens != null) {
        // Stack screens are named in brackets, as the screen-map walk reports them.
        for (name in screens.keys.sorted()) {
          val at = "$path.screens[${PrototypeSpecInput.canonicalString(name)}]"
          scan(screens.getValue(name), at, inHandler, found)
        }
      } else if (key !in opaqueKeys) {
        scan(value.getValue(key), keyPath(path, key), inHandler, found)
      }
    }
  }

  /** `{platform:/pointer}` placeholders, scanned exactly as `{data:/pointer}` ones. */
  private fun placeholders(text: String): List<String> {
    val prefix = "platform:"
    val found = mutableListOf<String>()
    var cursor = 0
    while (cursor < text.length) {
      if (text[cursor] != '{' || !text.startsWith(prefix, cursor + 1)) {
        cursor++
        continue
      }
      val end =
        minOf(
          text.length,
          cursor + 2 + prefix.length + PrototypeSpecValidator.MAX_PROTOTYPE_DATA_POINTER_LENGTH,
        )
      val close = (cursor + 1 until end).firstOrNull { text[it] == '}' }
      val pointer = close?.let { text.substring(cursor + 1 + prefix.length, it) }.orEmpty()
      if (close != null && PrototypeDataPointer.isValid(pointer)) {
        found.add(pointer)
        cursor = close + 1
      } else {
        cursor++
      }
    }
    return found
  }
}
