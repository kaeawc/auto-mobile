package dev.jasonpearson.automobile.desktop.core.daemon

import java.net.URLEncoder
import java.nio.charset.StandardCharsets

internal class ResourceUriBuilder(private val resourceUri: String) {
  private val parameters = mutableListOf<Pair<String, String>>()

  fun add(name: String, value: String?) {
    if (!value.isNullOrBlank()) {
      parameters.add(name to value)
    }
  }

  fun add(name: String, value: Int?) {
    value?.let { parameters.add(name to it.toString()) }
  }

  fun add(name: String, value: Boolean?) {
    value?.let { parameters.add(name to it.toString()) }
  }

  fun build(): String {
    if (parameters.isEmpty()) {
      return resourceUri
    }

    val query =
      parameters.joinToString("&") { (name, value) -> "$name=${encodeResourceUriComponent(value)}" }
    return "$resourceUri?$query"
  }
}

internal fun encodeResourceUriComponent(value: String): String =
  URLEncoder.encode(value, StandardCharsets.UTF_8.name())
