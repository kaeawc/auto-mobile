package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeBundleManifestCodec.text
import java.net.URI
import java.net.URLDecoder
import java.util.Locale
import kotlinx.serialization.json.*

data class PrototypeBundleSecretWarning(val code: String, val path: String)

/** Advisory only: paths never include a credential value, no DNS or raw-text scan. */
object PrototypeBundleSecrets {
  fun scan(specBytes: ByteArray): List<PrototypeBundleSecretWarning> {
    if (specBytes.size > PrototypeBundleLimits.MAX_SPEC_BYTES) return emptyList()
    return try {
      val root =
        PrototypeBundleJson.parse(
          specBytes,
          PrototypeBundleErrorCode.spec_invalid_json,
          "spec.json",
        )
      val pending = ArrayDeque<Pair<JsonElement, String>>()
      pending.add(root to "$")
      val warnings = mutableListOf<PrototypeBundleSecretWarning>()
      while (pending.isNotEmpty()) {
        val (value, path) = pending.removeLast()
        if (value is JsonObject && text(value["type"]) == "request")
          warnings.addAll(request(value, path))
        when (value) {
          is JsonObject -> value.forEach { (key, child) -> pending.add(child to "$path.$key") }
          is JsonArray ->
            value.forEachIndexed { index, child -> pending.add(child to "$path.$index") }
          else -> Unit
        }
      }
      warnings
    } catch (_: PrototypeBundleFailure) {
      // Export reports invalid specs; the advisory scan must not raise a second failure.
      emptyList()
    }
  }

  private fun request(action: JsonObject, path: String): List<PrototypeBundleSecretWarning> {
    val warnings = mutableListOf<PrototypeBundleSecretWarning>()
    for (name in (action["headers"] as? JsonObject).orEmpty().keys) {
      if (name.lowercase(Locale.ROOT) in setOf("authorization", "cookie", "x-api-key"))
        warnings.add(PrototypeBundleSecretWarning("credential_header", "$path.headers.$name"))
    }
    text(action["url"])?.let { warnings.addAll(url(it, "$path.url")) }
    return warnings
  }

  private fun url(value: String, path: String): List<PrototypeBundleSecretWarning> =
    try {
      // URI handles structure; percent-escape template braces/spaces like WHATWG URL before
      // parsing.
      val uri = URI(value.replace("{", "%7B").replace("}", "%7D").replace(" ", "%20"))
      require(uri.isAbsolute)
      val warnings = mutableListOf<PrototypeBundleSecretWarning>()
      for (pair in uri.rawQuery.orEmpty().split('&').filter { it.isNotEmpty() }) {
        val key = URLDecoder.decode(pair.substringBefore('='), Charsets.UTF_8)
        if (key.lowercase(Locale.ROOT) in setOf("token", "key", "secret", "sig"))
          warnings.add(PrototypeBundleSecretWarning("credential_query", "$path.query.$key"))
      }
      val host =
        (uri.host ?: uri.rawAuthority?.substringAfterLast('@')?.substringBefore(':'))
          .orEmpty()
          .removeSurrounding("[", "]")
          .lowercase(Locale.ROOT)
      val name = host.removeSuffix(".")
      if (
        name == "localhost" || name.endsWith(".localhost") || PrototypeBundleHosts.isPrivate(host)
      )
        warnings.add(PrototypeBundleSecretWarning("private_host", path))
      warnings
    } catch (_: IllegalArgumentException) {
      emptyList()
    } catch (_: java.net.URISyntaxException) {
      emptyList()
    }
}
