package dev.jasonpearson.automobile.sdk.persistence

import dev.jasonpearson.automobile.protocol.NavigationSourceType
import dev.jasonpearson.automobile.protocol.SdkCustomEvent
import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkNavigationEvent
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * Persistence layer for SDK events. Persists event batches to disk so they
 * survive process death and can be replayed on next launch.
 */
interface EventPersistence {
  /** Persist a batch of events to disk. Returns batch ID on success, null on failure. */
  fun persist(events: List<SdkEvent>): String?

  /** Load all pending batches from disk, ordered oldest-first (FIFO). */
  fun loadPending(): List<Pair<String, List<SdkEvent>>>

  /** Remove a successfully delivered batch by ID. */
  fun removeBatch(batchId: String)

  /** Remove batches older than [maxAgeDays]. */
  fun cleanup(maxAgeDays: Int = 7)
}

/**
 * File-based event persistence. One JSON file per batch.
 * Files named: events_{timestamp}_{uuid}.json for FIFO ordering.
 */
class FileEventPersistence(
  private val directory: File,
  private val clock: () -> Long = System::currentTimeMillis,
  private val uuidProvider: () -> String = { UUID.randomUUID().toString() },
) : EventPersistence {

  init {
    directory.mkdirs()
  }

  override fun persist(events: List<SdkEvent>): String? {
    if (events.isEmpty()) return null
    val batchId = "${clock()}_${uuidProvider()}"
    val file = File(directory, "events_$batchId.json")
    return try {
      file.writeText(serializeEvents(events))
      batchId
    } catch (_: Exception) {
      null
    }
  }

  override fun loadPending(): List<Pair<String, List<SdkEvent>>> {
    val files = directory.listFiles { f ->
      f.name.startsWith("events_") && f.name.endsWith(".json")
    } ?: return emptyList()

    return files.sortedBy { it.name }
      .mapNotNull { file ->
        try {
          val events = deserializeEvents(file.readText())
          val batchId = file.name.removePrefix("events_").removeSuffix(".json")
          batchId to events
        } catch (_: Exception) {
          file.delete() // corrupt file, remove it
          null
        }
      }
  }

  override fun removeBatch(batchId: String) {
    File(directory, "events_$batchId.json").delete()
  }

  override fun cleanup(maxAgeDays: Int) {
    val cutoff = clock() - (maxAgeDays * 24 * 60 * 60 * 1000L)
    directory.listFiles { f -> f.name.startsWith("events_") }?.forEach { file ->
      val timestamp = file.name.removePrefix("events_").substringBefore("_").toLongOrNull()
      if (timestamp != null && timestamp < cutoff) {
        file.delete()
      }
    }
  }

  internal fun serializeEvents(events: List<SdkEvent>): String {
    val array = JSONArray()
    for (event in events) {
      val obj = JSONObject()
      obj.put("type", event.javaClass.simpleName)
      obj.put("timestamp", event.timestamp)
      obj.put("applicationId", event.applicationId ?: "")
      when (event) {
        is SdkNavigationEvent -> {
          obj.put("destination", event.destination)
          obj.put("source", event.source.name)
          event.arguments?.let { obj.put("arguments", JSONObject(it)) }
          event.metadata?.let { obj.put("metadata", JSONObject(it)) }
        }
        is SdkCustomEvent -> {
          obj.put("name", event.name)
          obj.put("properties", JSONObject(event.properties))
        }
        else -> obj.put("data", event.toString())
      }
      array.put(obj)
    }
    return array.toString()
  }

  internal fun deserializeEvents(json: String): List<SdkEvent> {
    val array = JSONArray(json)
    val events = mutableListOf<SdkEvent>()
    for (i in 0 until array.length()) {
      val obj = array.getJSONObject(i)
      val type = obj.optString("type")
      val timestamp = obj.optLong("timestamp")
      val appId = obj.optString("applicationId").ifEmpty { null }
      when (type) {
        "SdkCustomEvent" -> events.add(
          SdkCustomEvent(
            timestamp = timestamp,
            applicationId = appId,
            name = obj.optString("name"),
            properties = jsonObjectToMap(obj.optJSONObject("properties")),
          ),
        )
        "SdkNavigationEvent" -> {
          val sourceName = obj.optString("source")
          val source = try {
            NavigationSourceType.valueOf(sourceName)
          } catch (_: Exception) {
            NavigationSourceType.CUSTOM
          }
          events.add(
            SdkNavigationEvent(
              timestamp = timestamp,
              applicationId = appId,
              destination = obj.optString("destination"),
              source = source,
              arguments = obj.optJSONObject("arguments")?.let { jsonObjectToMap(it) },
              metadata = obj.optJSONObject("metadata")?.let { jsonObjectToMap(it) },
            ),
          )
        }
        // Other event types are silently skipped on deserialization.
        // They were still persisted (best-effort) and will be cleaned up on expiry.
      }
    }
    return events
  }

  private fun jsonObjectToMap(obj: JSONObject?): Map<String, String> {
    if (obj == null) return emptyMap()
    val map = mutableMapOf<String, String>()
    for (key in obj.keys()) {
      map[key] = obj.optString(key)
    }
    return map
  }
}
