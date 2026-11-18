package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import java.io.IOException
import java.util.UUID
import okhttp3.FormBody
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.Buffer
import okio.BufferedSink
import okio.ForwardingSink
import okio.buffer

internal class PrototypeUploadRequestBodies(
  private val clock: () -> Long,
  private val newBoundary: () -> String = { UUID.randomUUID().toString() },
) {
  fun create(request: PrototypeHttpRequest): RequestBody {
    val upload = checkNotNull(request.uploadBody)
    require(request.body == null) { "Choose either JSON or an upload body." }
    require(upload.fileBytes <= PrototypeSpecValidator.MAX_PROTOTYPE_UPLOAD_BYTES) {
      "Upload file bytes exceed ${PrototypeSpecValidator.MAX_PROTOTYPE_UPLOAD_BYTES}; use smaller assets."
    }
    val body =
      when (upload) {
        is PrototypeUploadBody.Form ->
          FormBody.Builder()
            .apply { upload.entries.forEach { (name, value) -> add(name, value) } }
            .build()
        is PrototypeUploadBody.FileBody -> streamingFile(upload)
        is PrototypeUploadBody.Multipart -> multipart(upload)
      }
    return request.onUploadProgress?.let { withUploadProgress(body, it) } ?: body
  }

  private fun multipart(upload: PrototypeUploadBody.Multipart): RequestBody =
    MultipartBody.Builder(newBoundary())
      .setType(MultipartBody.FORM)
      .apply {
        upload.parts.forEach { part ->
          val file = part.file
          when {
            file != null ->
              addFormDataPart(part.name, checkNotNull(part.filename), streamingFile(file))
            part.filename == null && part.contentType == null ->
              addFormDataPart(part.name, checkNotNull(part.value))
            else ->
              addFormDataPart(
                part.name,
                part.filename,
                checkNotNull(part.value).toRequestBody(part.contentType?.toMediaType()),
              )
          }
        }
      }
      .build()

  private fun withUploadProgress(body: RequestBody, progress: (Int) -> Unit): RequestBody =
    object : RequestBody() {
      override fun contentType(): MediaType? = body.contentType()

      override fun contentLength(): Long = body.contentLength()

      override fun writeTo(sink: BufferedSink) {
        val length = contentLength()
        var written = 0L
        var last = clock()
        progress(0)
        val counting =
          object : ForwardingSink(sink) {
              override fun write(source: Buffer, byteCount: Long) {
                super.write(source, byteCount)
                written += byteCount
                val now = clock()
                if (now - last >= 100L) {
                  last = now
                  progress(
                    if (length == 0L) 100 else ((written * 100L) / length).coerceIn(0, 100).toInt(),
                  )
                }
              }
            }
            .buffer()
        body.writeTo(counting)
        counting.flush()
      }
    }

  private fun streamingFile(upload: PrototypeUploadBody.FileBody): RequestBody {
    val file = upload.file
    if (!file.isFile || !file.canRead()) {
      throw PrototypeUploadException(
        "Upload asset file is missing; upload the asset again before requesting.",
      )
    }
    val length = upload.byteCount
    if (length < 0 || file.length() != length) {
      throw PrototypeUploadException("Upload asset changed; upload it again before requesting.")
    }
    return object : RequestBody() {
      override fun contentType(): MediaType = upload.contentType.toMediaType()

      override fun contentLength(): Long = length

      override fun writeTo(sink: BufferedSink) {
        try {
          file.inputStream().use { source ->
            val chunk = ByteArray(8192)
            var remaining = length
            while (remaining > 0) {
              val read = source.read(chunk, 0, minOf(chunk.size.toLong(), remaining).toInt())
              if (read < 0) {
                throw PrototypeUploadException(
                  "Upload asset changed; upload it again before requesting.",
                )
              }
              sink.write(chunk, 0, read)
              sink.emitCompleteSegments()
              remaining -= read
            }
            if (source.read() != -1) {
              throw PrototypeUploadException(
                "Upload asset changed; upload it again before requesting.",
              )
            }
          }
        } catch (error: java.io.FileNotFoundException) {
          throw PrototypeUploadException(
            "Upload asset file is missing; upload it again before requesting.",
            error,
          )
        }
      }
    }
  }
}

internal class PrototypeUploadException(message: String, cause: Throwable? = null) :
  IOException(message, cause)
