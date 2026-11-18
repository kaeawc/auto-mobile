package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/** Resolves a keyed set/remove to one ordinary array replacement, preserving atomic validation. */
internal object PrototypeKeyedDataWrite {
  fun appliesTo(write: PrototypeDataWrite): Boolean =
    when (write) {
      is PrototypeDataWrite.Set -> write.where != null || write.member != null
      is PrototypeDataWrite.Remove -> write.where != null
      else -> false
    }

  fun apply(
    data: JsonObject,
    pointer: String,
    write: PrototypeDataWrite,
  ): PrototypeDataWriteResult {
    val where = selector(write)
    val member = (write as? PrototypeDataWrite.Set)?.member
    if (!validSelector(where, member))
      return refused(
        PrototypeDataWriteErrorCode.INVALID_PATH,
        "Keyed writes need safe field and member names and a where selector",
      )
    val target =
      PrototypeDataPointer.resolve(data, pointer)
        ?: return refused(
          PrototypeDataWriteErrorCode.NOT_FOUND,
          "Keyed target ${write.path} does not exist",
        )
    if (target !is JsonArray)
      return refused(
        PrototypeDataWriteErrorCode.NOT_ARRAY,
        "Keyed target ${write.path} is not an array",
      )
    val matches = matchingIndices(target, checkNotNull(where))
    if (matches.isEmpty())
      return refused(PrototypeDataWriteErrorCode.NOT_FOUND, "No element matches where")
    if (matches.size > 1)
      return refused(
        PrototypeDataWriteErrorCode.AMBIGUOUS_MATCH,
        "More than one element matches where",
      )
    val changed = replacement(target, matches.single(), write)
    return PrototypeDataWriter.apply(data, PrototypeDataWrite.Set(write.path, changed))
  }

  private fun selector(write: PrototypeDataWrite): PrototypeDataMatch? =
    when (write) {
      is PrototypeDataWrite.Set -> write.where
      is PrototypeDataWrite.Remove -> write.where
      else -> null
    }

  private fun validSelector(where: PrototypeDataMatch?, member: String?): Boolean {
    if (where == null || !validName(where.field)) return false
    return member == null || validName(member)
  }

  private fun validName(name: String): Boolean =
    name.length in 1..PrototypeSpecValidator.MAX_PROTOTYPE_DATA_POINTER_LENGTH &&
      '/' !in name &&
      '~' !in name

  private fun matchingIndices(target: JsonArray, where: PrototypeDataMatch): List<Int> =
    target.indices.filter { index ->
      (target[index] as? JsonObject)?.get(where.field)?.let {
        PrototypeDataArrayWindow.sameKey(it, where.equals)
      } == true
    }

  private fun replacement(target: JsonArray, index: Int, write: PrototypeDataWrite): JsonArray {
    val changed = target.toMutableList()
    if (write is PrototypeDataWrite.Set) {
      val member = write.member
      changed[index] =
        if (member == null) write.value
        else JsonObject((target[index] as JsonObject) + (member to write.value))
    } else {
      changed.removeAt(index)
    }
    return JsonArray(changed)
  }

  private fun refused(code: PrototypeDataWriteErrorCode, message: String) =
    PrototypeDataWriteResult.Failure(PrototypeDataWriteError(code, message))
}
