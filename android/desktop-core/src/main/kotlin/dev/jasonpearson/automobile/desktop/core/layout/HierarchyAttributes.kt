package dev.jasonpearson.automobile.desktop.core.layout

import dev.jasonpearson.automobile.desktop.domain.NodeDiffState
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/** Parse bounds from either the attributes object or a separate bounds object. */
internal fun parseBounds(attrs: JsonObject, nodeObj: JsonObject): ElementBounds {
  return parseBoundsElement(attrs["bounds"])
    ?: parseBoundsElement(nodeObj["bounds"])
    ?: ElementBounds(0, 0, 0, 0)
}

private fun parseBoundsElement(boundsElement: JsonElement?): ElementBounds? {
  return when (boundsElement) {
    is JsonObject -> parseObjectBounds(boundsElement)
    is JsonPrimitive -> boundsElement.contentOrNull?.let { parseBoundsString(it) }
    // Compact form emitted by the MCP server's --observe-result-compact flag:
    // bounds is the positional tuple [left, top, right, bottom]. Mirrors the
    // sibling RealLayoutDataSource.parseBounds so both hierarchy parsers agree.
    is JsonArray -> parseArrayBounds(boundsElement)
    else -> null
  }
}

private fun parseObjectBounds(bounds: JsonObject): ElementBounds =
  ElementBounds(
    left = bounds.getInt("left") ?: 0,
    top = bounds.getInt("top") ?: 0,
    right = bounds.getInt("right") ?: 0,
    bottom = bounds.getInt("bottom") ?: 0,
  )

private fun parseArrayBounds(bounds: JsonArray): ElementBounds {
  if (bounds.size != 4) return ElementBounds(0, 0, 0, 0)
  fun coordinate(index: Int) = (bounds[index] as? JsonPrimitive)?.intOrNull ?: 0
  return ElementBounds(coordinate(0), coordinate(1), coordinate(2), coordinate(3))
}

/** Parse legacy uiautomator bounds string format "[left,top][right,bottom]". */
private fun parseBoundsString(boundsStr: String): ElementBounds {
  val regex = """\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]""".toRegex()
  val match = regex.find(boundsStr)
  return if (match != null) {
    val (left, top, right, bottom) = match.destructured
    ElementBounds(
      left = left.toIntOrNull() ?: 0,
      top = top.toIntOrNull() ?: 0,
      right = right.toIntOrNull() ?: 0,
      bottom = bottom.toIntOrNull() ?: 0,
    )
  } else {
    ElementBounds(0, 0, 0, 0)
  }
}

/**
 * Map the daemon's `diffState` wire value to the typed enum; unknown/absent values render unmarked.
 */
internal fun parseDiffState(value: String?): NodeDiffState? =
  when (value) {
    "added" -> NodeDiffState.Added
    "changed" -> NodeDiffState.Changed
    else -> null
  }

/** Parse the "extras" map from node JSON. Checks both the attributes object and the node itself. */
internal fun parseExtras(attrs: JsonObject, nodeObj: JsonObject): Map<String, String> {
  val extrasObj = (attrs["extras"] ?: nodeObj["extras"]) as? JsonObject ?: return emptyMap()
  val result = mutableMapOf<String, String>()
  for ((key, value) in extrasObj) {
    if (value is JsonPrimitive) {
      value.contentOrNull?.let { result[key] = it }
    }
  }
  return result
}

// Extension functions for safe JSON access

internal fun JsonObject.getString(key: String): String? {
  return this[key]?.let {
    when (it) {
      is JsonPrimitive -> it.contentOrNull?.takeIf { str -> str.isNotEmpty() }
      else -> null
    }
  }
}

private fun JsonObject.getInt(key: String): Int? {
  return this[key]?.let {
    when (it) {
      is JsonPrimitive -> it.intOrNull
      else -> null
    }
  }
}
