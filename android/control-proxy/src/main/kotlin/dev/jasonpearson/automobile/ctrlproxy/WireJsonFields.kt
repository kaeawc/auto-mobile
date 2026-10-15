package dev.jasonpearson.automobile.ctrlproxy

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** Appends a comma-prefixed JSON string field, escaping both its name and value. */
internal fun StringBuilder.appendJsonStringField(name: String, value: String, json: Json) {
  append(',')
  append(json.encodeToString(name))
  append(':')
  append(json.encodeToString(value))
}
