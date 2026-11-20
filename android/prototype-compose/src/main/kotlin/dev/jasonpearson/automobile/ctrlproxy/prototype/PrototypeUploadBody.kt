package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.EmitContextInputs
import dev.jasonpearson.automobile.protocol.PrototypeDataValue
import dev.jasonpearson.automobile.protocol.PrototypeDataWriteError
import dev.jasonpearson.automobile.protocol.PrototypeDataWriter
import dev.jasonpearson.automobile.protocol.PrototypeRequestUploadPart
import dev.jasonpearson.automobile.protocol.PrototypeRequests
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import java.io.File
import kotlinx.serialization.json.*

/** Resolved uploads retain file paths, never a whole-file byte array. */
@InternalAutoMobilePrototypeApi
sealed interface PrototypeUploadBody {
  data class Multipart(val parts: List<Part>) : PrototypeUploadBody

  data class Form(val entries: Map<String, String>) : PrototypeUploadBody

  data class FileBody(
    val file: File,
    val contentType: String,
    val byteCount: Long = file.length(),
  ) : PrototypeUploadBody

  data class Part(
    val name: String,
    val value: String? = null,
    val file: FileBody? = null,
    val filename: String? = null,
    val contentType: String? = null,
  )

  val fileBytes: Long
    get() =
      when (this) {
        is Multipart -> parts.sumOf { it.file?.byteCount ?: 0L }
        is Form -> 0L
        is FileBody -> byteCount
      }
}

/** Kept separate from JSON binding resolution, which deliberately knows nothing about assets. */
internal class PrototypeUploadBindingException(val error: PrototypeDataWriteError) :
  IllegalArgumentException(error.message)

internal object PrototypeUploadResolver {
  fun isUpload(body: JsonObject?): Boolean =
    body != null && body.keys.any { it in setOf("multipart", "form", "file") }

  fun resolve(
    body: JsonObject,
    inputs: EmitContextInputs,
    assets: PrototypeAssetSource?,
  ): PrototypeUploadBody {
    val upload =
      when {
        "multipart" in body ->
          PrototypeUploadBody.Multipart(
            multipartParts(body, inputs, assets),
          )
        "form" in body ->
          PrototypeUploadBody.Form(
            body.getValue("form").jsonObject.toSortedMap().mapValues { (_, value) ->
              text(value.jsonObject, inputs)
            },
          )
        else ->
          file(
            body.getValue("file").jsonObject.getValue("asset").jsonPrimitive.content,
            body.getValue("contentType").jsonPrimitive.content,
            assets,
          )
      }
    require(upload.fileBytes <= PrototypeSpecValidator.MAX_PROTOTYPE_UPLOAD_BYTES) {
      "Upload file bytes exceed ${PrototypeSpecValidator.MAX_PROTOTYPE_UPLOAD_BYTES}; use smaller assets."
    }
    return upload
  }

  private fun file(
    id: String,
    contentType: String?,
    assets: PrototypeAssetSource?,
  ): PrototypeUploadBody.FileBody {
    val stored = assets?.file(id)
    require(stored != null && stored.isFile && stored.canRead()) {
      "Upload asset '$id' is missing or not file-backed; upload the asset again before requesting."
    }
    return PrototypeUploadBody.FileBody(stored, contentType ?: "application/octet-stream")
  }

  private fun text(binding: JsonObject, inputs: EmitContextInputs): String {
    val value =
      when (val result = PrototypeDataWriter.resolveValue(binding, inputs)) {
        is PrototypeDataValue.Resolved -> result.value
        is PrototypeDataValue.Failure -> throw PrototypeUploadBindingException(result.error)
      }
    return when {
      value is JsonPrimitive && value.isString -> value.content
      value is JsonPrimitive && value.doubleOrNull != null ->
        PrototypeRequests.numberText(checkNotNull(value.doubleOrNull))
      else -> PrototypeRequests.sortedKeys(value).toString()
    }
  }

  private fun multipartParts(
    body: JsonObject,
    inputs: EmitContextInputs,
    assets: PrototypeAssetSource?,
  ): List<PrototypeUploadBody.Part> =
    body.getValue("multipart").jsonArray.map { raw ->
      val part = Json.decodeFromJsonElement(PrototypeRequestUploadPart.serializer(), raw)
      val uploadFile = part.file
      if (uploadFile != null) {
        PrototypeUploadBody.Part(
          part.name,
          file = file(uploadFile.asset, part.contentType, assets),
          filename = part.filename ?: uploadFile.asset,
        )
      } else {
        PrototypeUploadBody.Part(
          part.name,
          value = text(checkNotNull(part.value), inputs),
          filename = part.filename,
          contentType = part.contentType,
        )
      }
    }
}
