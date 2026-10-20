package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer

internal class McpHttpResources(private val transport: McpHttpTransport) {
  private val json = transport.json

  fun ping() {
    transport.ensureInitialized()
  }

  fun listResources(): List<McpResource> {
    transport.ensureInitialized()
    val response = transport.sendRequest("resources/list")
    val result =
      json.decodeFromJsonElement(
        serializer<ListResourcesResult>(),
        response.resultFor("resources/list"),
      )
    return result.resources
  }

  fun listResourceTemplates(): List<McpResourceTemplate> {
    transport.ensureInitialized()
    val response = transport.sendRequest("resources/list-templates")
    val result =
      json.decodeFromJsonElement(
        serializer<ListResourceTemplatesResult>(),
        response.resultFor("resources/list-templates"),
      )
    return result.resourceTemplates
  }

  fun listTools(): List<McpTool> {
    transport.ensureInitialized()
    val response = transport.sendRequest("tools/list")
    val result =
      json.decodeFromJsonElement(serializer<ListToolsResult>(), response.resultFor("tools/list"))
    return result.tools
  }

  fun readResource(uri: String): List<McpResourceContent> {
    transport.ensureInitialized()
    val response =
      transport.sendRequest(
        "resources/read",
        buildJsonObject { put("uri", JsonPrimitive(uri)) },
      )
    val result =
      json.decodeFromJsonElement(
        serializer<ReadResourceResult>(),
        response.resultFor("resources/read"),
      )
    return result.contents
  }
}
