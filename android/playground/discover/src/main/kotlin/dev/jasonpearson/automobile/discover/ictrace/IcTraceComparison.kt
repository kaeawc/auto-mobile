package dev.jasonpearson.automobile.discover.ictrace

import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json

/** Reads exported IC JSONL captures and compares their observable editor contract. */
object IcTraceComparison {
  private val json = Json { ignoreUnknownKeys = true }

  sealed interface Result {
    data class Equivalent(
      val eventCount: Int,
      val referenceKeyboard: KeyboardIdentity,
      val candidateKeyboard: KeyboardIdentity,
    ) : Result

    data class Different(val mismatches: List<Mismatch>) : Result

    data class Inconclusive(val reasons: List<String>) : Result
  }

  data class Mismatch(val location: String, val reference: String, val candidate: String)

  data class KeyboardIdentity(val id: String?, val version: String?)

  fun compareJsonl(reference: String, candidate: String): Result {
    val referenceEvents = parse(reference, "reference")
    val candidateEvents = parse(candidate, "candidate")
    val parseIssues = referenceEvents.second + candidateEvents.second
    if (parseIssues.isNotEmpty()) return Result.Inconclusive(parseIssues)
    return compare(referenceEvents.first, candidateEvents.first)
  }

  fun compare(reference: List<IcTraceEvent>, candidate: List<IcTraceEvent>): Result {
    val incomplete =
      listOf("reference" to reference, "candidate" to candidate).flatMap { (label, events) ->
        buildList {
          if (events.isEmpty()) add("$label capture contains no events")
          if (events.any { it.droppedEvents > 0 }) add("$label capture reports dropped events")
          if (events.zipWithNext().any { (left, right) -> right.seq != left.seq + 1 }) {
            add("$label capture has a sequence gap")
          }
        }
      }
    if (incomplete.isNotEmpty()) return Result.Inconclusive(incomplete)

    val mismatches = mutableListOf<Mismatch>()
    val commonMetadata = minOf(reference.size, candidate.size)
    for (index in 0 until commonMetadata) {
      val left = comparableEnvironment(reference[index].metadata)
      val right = comparableEnvironment(candidate[index].metadata)
      if (left != right) {
        mismatches += Mismatch("events[$index].metadata", left.toString(), right.toString())
      }
    }
    if (reference.size != candidate.size) {
      mismatches += Mismatch("events.length", reference.size.toString(), candidate.size.toString())
    }

    val common = minOf(reference.size, candidate.size)
    for (index in 0 until common) {
      val left = reference[index]
      val right = candidate[index]
      val prefix = "events[$index]"
      compareField(mismatches, "$prefix.call", left.call, right.call)
      compareField(mismatches, "$prefix.args", left.args, right.args)
      compareField(mismatches, "$prefix.result", left.result, right.result)
      compareField(mismatches, "$prefix.readValue", left.readValue, right.readValue)
      compareField(mismatches, "$prefix.selectionStart", left.selectionStart, right.selectionStart)
      compareField(mismatches, "$prefix.selectionEnd", left.selectionEnd, right.selectionEnd)
      compareField(mismatches, "$prefix.composingStart", left.composingStart, right.composingStart)
      compareField(mismatches, "$prefix.composingEnd", left.composingEnd, right.composingEnd)
    }

    if (mismatches.isNotEmpty()) return Result.Different(mismatches)
    return Result.Equivalent(
      reference.size,
      reference.first().metadata.identity(),
      candidate.first().metadata.identity(),
    )
  }

  private fun parse(jsonl: String, label: String): Pair<List<IcTraceEvent>, List<String>> {
    val events = mutableListOf<IcTraceEvent>()
    val issues = mutableListOf<String>()
    jsonl.lineSequence().forEachIndexed { index, line ->
      if (line.isBlank()) return@forEachIndexed
      try {
        events += json.decodeFromString<IcTraceEvent>(line)
      } catch (error: SerializationException) {
        issues += "$label line ${index + 1} is invalid: ${error.message ?: "invalid event"}"
      } catch (error: IllegalArgumentException) {
        issues += "$label line ${index + 1} is invalid: ${error.message ?: "invalid event"}"
      }
    }
    return events to issues
  }

  private fun comparableEnvironment(metadata: IcTraceMetadata) =
    metadata.copy(keyboardId = null, keyboardVersion = null)

  private fun IcTraceMetadata.identity() = KeyboardIdentity(keyboardId, keyboardVersion)

  private fun compareField(
    mismatches: MutableList<Mismatch>,
    location: String,
    reference: Any?,
    candidate: Any?,
  ) {
    if (reference != candidate) {
      mismatches += Mismatch(location, reference.toString(), candidate.toString())
    }
  }
}
