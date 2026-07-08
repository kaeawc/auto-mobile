package dev.jasonpearson.automobile.ctrlproxy

internal data class ScreenshotCapturePayload(
  val base64Image: String,
  val captureDurationMs: Long,
  val encodeDurationMs: Long,
  val byteLength: Int,
  val base64Length: Int,
)

internal fun buildScreenshotMessageJson(
  requestId: String?,
  timestampMs: Long,
  screenshot: ScreenshotCapturePayload,
): String =
  buildString {
    append("""{"type":"screenshot","timestamp":$timestampMs""")
    if (requestId != null) {
      append(""","requestId":"$requestId"""")
    }
    append(""","format":"jpeg","data":"${screenshot.base64Image}"""")
    append(""","screenshotCaptureDurationMs":${screenshot.captureDurationMs}""")
    append(""","screenshotEncodeDurationMs":${screenshot.encodeDurationMs}""")
    append(""","screenshotByteLength":${screenshot.byteLength}""")
    append(""","screenshotBase64Length":${screenshot.base64Length}""")
    append("}")
  }
