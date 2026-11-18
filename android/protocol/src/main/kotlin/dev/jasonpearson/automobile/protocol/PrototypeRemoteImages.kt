package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonObject

/** URL-image contract only; loaders enforce development flavor and redirect policy. */
object PrototypeRemoteImages {
  const val CAPABILITY = "prototype_remote_image_v1"
  const val MAX_PROTOTYPE_REMOTE_IMAGE_URL_LENGTH = 2048
  const val MAX_PROTOTYPE_REMOTE_IMAGE_DOWNLOAD_BYTES = 8388608
  const val PROTOTYPE_REMOTE_IMAGE_ANDROID_HEAP_DIVISOR = 8
  const val MAX_PROTOTYPE_REMOTE_IMAGE_IOS_MEMORY_BYTES = 67108864
  const val MAX_PROTOTYPE_REMOTE_IMAGE_DISK_BYTES = 134217728
  const val MAX_PROTOTYPE_REMOTE_IMAGE_LOADS = 6

  private val authority = Regex("^https?://([^/?#]+)", RegexOption.IGNORE_CASE)
  private val loopback =
    Regex(
      "^http://(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(?::[0-9]+)?(?:[/?#]|$)",
      RegexOption.IGNORE_CASE,
    )
  private val unsafe = Regex("[\\\\\\u0000-\\u001f\\u007f-\\u009f]")

  internal fun error(
    root: JsonObject,
    nodes: List<PrototypeStateChecks.Located>,
  ): PrototypeSpecError? {
    val state = root["state"] as? JsonObject
    return nodes
      .filter { it.value.text("type") == "image" }
      .firstNotNullOfOrNull { (node, path) -> nodeError(node, path, state) }
  }

  private fun nodeError(node: JsonObject, path: String, state: JsonObject?): PrototypeSpecError? {
    if ((node["asset"] != null) == (node["url"] != null))
      return fail(path, "image requires exactly one of asset or url")
    val url = node.text("url") ?: return null
    if (stateKeys(url).any { it != "index" && state?.containsKey(it) != true }) {
      return fail("$path.url", "Remote image URL references an undeclared state key")
    }
    if (node.text("via") == "host" && '{' in url)
      return fail("$path.via", "Host remote images require a static URL")
    if (url.startsWith("{")) return null
    PrototypeRequestRules.requestUrlError(url)?.let {
      return fail("$path.url", it)
    }
    return if (unsafeURL(url))
      fail(
        "$path.url",
        "Remote image URL requires HTTPS or literal loopback HTTP, without credentials, whitespace or backslashes",
      )
    else null
  }

  private fun stateKeys(text: String): List<String> =
    PrototypeDataText.pointers(text, "", PrototypeRepeatTemplate::isFieldName)

  private fun unsafeURL(url: String): Boolean {
    val host = authority.find(url)?.groupValues?.get(1) ?: return true
    val blank = url.any { PrototypeSpecContract.blankTextPattern.matches(it.toString()) }
    return '@' in host ||
      unsafe.containsMatchIn(url) ||
      blank ||
      (url.startsWith("http:", ignoreCase = true) && !loopback.containsMatchIn(url))
  }
}
