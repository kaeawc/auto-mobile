package dev.jasonpearson.automobile.protocol

import java.net.URI
import java.util.Locale

/** Registration guard; raw URLs still use the matcher's custom authority/path semantics. */
object PrototypeLinkResolver {
  data class Web(val scheme: String, val host: String)

  data class Registration(val schemes: List<String>, val web: List<Web> = emptyList())

  fun resolve(
    url: String,
    registration: Registration,
    entries: List<PrototypeLinkMatcher.Entry>,
  ): PrototypeLinkMatcher.Match? {
    val separator = url.indexOf("://")
    if (separator <= 0) return null
    val scheme = url.substring(0, separator).lowercase(Locale.ROOT)
    if (scheme == "http" || scheme == "https") {
      val parsed = runCatching { URI(url) }.getOrNull() ?: return null
      if (parsed.rawUserInfo != null || parsed.host == null) return null
      val host =
        parsed.host +
          if (parsed.port >= 0 && parsed.port != (if (scheme == "https") 443 else 80))
            ":${parsed.port}"
          else ""
      if (registration.web.none { it.scheme.equals(scheme, true) && it.host.equals(host, true) })
        return null
    } else if (registration.schemes.none { it.equals(scheme, true) }) return null
    return PrototypeLinkMatcher.match(url, entries)
  }
}
