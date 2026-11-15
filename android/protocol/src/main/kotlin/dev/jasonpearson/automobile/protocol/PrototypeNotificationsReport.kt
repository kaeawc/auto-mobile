package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

/**
 * The `notifications` module report (#14277), the twin of TypeScript's
 * `prototypeNotificationsReport`: it builds `{permission, badge, channels, active, pending}` from a
 * platform snapshot whose `posted` and `pending` entries carry the platform `tag`. Only
 * `proto:<id>` tags are reported, as `id`. Both replay
 * `test/fixtures/prototype-notifications/report.json`.
 *
 * On Android the runtime fills the snapshot from `NotificationManager.getActiveNotifications()`.
 */
object PrototypeNotificationsReport {
  const val TAG_PREFIX = "proto:"

  /** The prototype notification id a `proto:<id>` tag names, or null for any other tag. */
  fun idOfTag(tag: JsonElement?): String? {
    val text = tag.text() ?: return null
    return if (text.startsWith(TAG_PREFIX) && text.length > TAG_PREFIX.length)
      text.substring(TAG_PREFIX.length)
    else null
  }

  fun of(snapshot: JsonElement): JsonObject {
    val input = snapshot as? JsonObject ?: JsonObject(emptyMap())
    val badge = input["badge"].finite()
    return JsonObject(
      mapOf(
        "permission" to JsonPrimitive(input["permission"].text() ?: "unavailable"),
        "badge" to
          if (badge != null && badge >= 0 && badge == Math.floor(badge)) input.getValue("badge")
          else JsonPrimitive(0),
        "channels" to
          JsonArray(
            entries(input["channels"])
              .mapNotNull(::channel)
              .sortedBy { it.id }
              .map {
                it.json
              },
          ),
        "active" to
          JsonArray(
            entries(input["posted"])
              .mapNotNull(::active)
              .sortedWith(compareBy<Sorted> { it.time }.thenBy { it.id })
              .map { it.json },
          ),
        "pending" to
          JsonArray(
            entries(input["pending"])
              .mapNotNull(::pending)
              .sortedWith(compareBy<Sorted> { it.time }.thenBy { it.id })
              .map { it.json },
          ),
      ),
    )
  }

  private class Sorted(val id: String, val time: Double, val json: JsonObject)

  private fun channel(entry: JsonObject): Sorted? {
    val id = entry["id"].text() ?: return null
    if (entry["importance"].text() == null) return null
    return Sorted(
      id,
      0.0,
      JsonObject(
        mapOf(
          "id" to entry.getValue("id"),
          "importance" to entry.getValue("importance"),
          "blocked" to JsonPrimitive(entry["blocked"].isTrue()),
        ),
      ),
    )
  }

  private fun active(entry: JsonObject): Sorted? {
    val id = idOfTag(entry["tag"]) ?: return null
    if (entry["channel"].text() == null || entry["title"].text() == null) return null
    val postedAt = entry["postedAt"].finite() ?: return null
    val fields = linkedMapOf<String, JsonElement>()
    fields["id"] = JsonPrimitive(id)
    fields["channel"] = entry.getValue("channel")
    fields["title"] = entry.getValue("title")
    if (entry["body"].text() != null) fields["body"] = entry.getValue("body")
    if (entry["group"].text() != null) fields["group"] = entry.getValue("group")
    fields["ongoing"] = JsonPrimitive(entry["ongoing"].isTrue())
    progress(entry["progress"])?.let { fields["progress"] = it }
    fields["actions"] =
      JsonArray((entry["actions"] as? JsonArray).orEmpty().filter { it.text() != null })
    fields["postedAt"] = entry.getValue("postedAt")
    return Sorted(id, postedAt, JsonObject(fields))
  }

  private fun pending(entry: JsonObject): Sorted? {
    val id = idOfTag(entry["tag"]) ?: return null
    val fireAt = entry["fireAt"].finite() ?: return null
    return Sorted(
      id,
      fireAt,
      JsonObject(mapOf("id" to JsonPrimitive(id), "fireAt" to entry.getValue("fireAt"))),
    )
  }

  private fun progress(value: JsonElement?): JsonObject? {
    val progress = value as? JsonObject ?: return null
    val fraction = progress["value"].finite()
    if (fraction != null && fraction in 0.0..1.0)
      return JsonObject(mapOf("value" to progress.getValue("value")))
    return if (progress["indeterminate"].isTrue())
      JsonObject(mapOf("indeterminate" to JsonPrimitive(true)))
    else null
  }

  private fun entries(value: JsonElement?): List<JsonObject> =
    (value as? JsonArray).orEmpty().filterIsInstance<JsonObject>()

  private fun JsonElement?.text(): String? =
    (this as? JsonPrimitive)?.takeIf { it.isString }?.content

  private fun JsonElement?.finite(): Double? =
    (this as? JsonPrimitive)
      ?.takeIf { !it.isString && it !is JsonNull }
      ?.doubleOrNull
      ?.takeIf { it.isFinite() }

  private fun JsonElement?.isTrue(): Boolean =
    (this as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull == true
}
