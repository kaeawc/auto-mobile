package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.shell.InspectorTabBar

@Composable
internal fun NetworkTabbedDetail(
  event: TelemetryDisplayEvent.Network,
  textColor: Color,
  focusedBorderColor: Color,
) {
  val tabs = listOf("Overview", "Headers", "Request", "Response")
  var selectedTab by remember(event) { mutableStateOf(0) }

  // Hoist replay state to this level so it persists across tab switches.
  var replayResult by remember(event) { mutableStateOf<NetworkReplayResult?>(null) }
  var isRunning by remember(event) { mutableStateOf(false) }

  InspectorTabBar(
    tabs = tabs,
    selected = selectedTab,
    onSelect = { selectedTab = it },
    textColor = textColor,
    focusedBorderColor = focusedBorderColor,
  )

  when (selectedTab) {
    0 ->
      NetworkOverviewTab(
        event = event,
        textColor = textColor,
        replayResult = replayResult,
        isRunning = isRunning,
        onRunReplay = {
          isRunning = true
          replayResult = null
          Thread {
            val result =
              NetworkRequestRunner.run(
                url = event.url,
                method = event.method,
                requestHeaders = event.requestHeaders,
                requestBody = event.requestBody,
              )
            javax.swing.SwingUtilities.invokeLater {
              replayResult = result
              isRunning = false
            }
          }
            .start()
        },
      )
    1 -> NetworkHeadersTab(event, textColor)
    2 -> NetworkRequestTab(event, textColor)
    3 -> NetworkResponseTab(event, textColor)
  }
}

@Composable
internal fun NetworkOverviewTab(
  event: TelemetryDisplayEvent.Network,
  textColor: Color,
  replayResult: NetworkReplayResult?,
  isRunning: Boolean,
  onRunReplay: () -> Unit,
) {
  DetailRow("Method", event.method, textColor)
  DetailRow("Status", "${event.statusCode}", textColor)
  DetailRow("URL", event.url, textColor)
  DetailRow("Duration", "${event.durationMs}ms", textColor)
  event.host?.let { DetailRow("Host", it, textColor) }
  event.path?.let { DetailRow("Path", it, textColor) }
  event.error?.let { DetailRow("Error", it, textColor) }

  val reqSize = (event.requestHeaders?.get("Content-Length")?.toLongOrNull()) ?: -1
  val respSize = (event.responseHeaders?.get("Content-Length")?.toLongOrNull()) ?: -1
  if (reqSize > 0) DetailRow("Request Size", formatByteSize(reqSize), textColor)
  if (respSize > 0) DetailRow("Response Size", formatByteSize(respSize), textColor)

  // cURL command
  Spacer(Modifier.height(8.dp))
  val curlCommand = remember(event) { networkAsCurl(event) }
  CollapsibleSection("cURL", textColor, copyText = curlCommand) {
    MonospaceBlock(curlCommand, textColor)
  }

  // Run button — state is owned by the parent NetworkTabbedDetail so it
  // persists when the user switches away from this tab and back.
  Spacer(Modifier.height(8.dp))
  ActionButton(if (isRunning) "Running..." else "Run", textColor, enabled = !isRunning) {
    onRunReplay()
  }

  replayResult?.let { NetworkReplayOverview(it, textColor) }
}

@Composable
internal fun NetworkHeadersTab(event: TelemetryDisplayEvent.Network, textColor: Color) {
  val reqHeadersCopy =
    remember(event.requestHeaders) {
      event.requestHeaders?.entries?.joinToString("\n") { "${it.key}: ${it.value}" }
    }
  CollapsibleSection(
    "Request Headers",
    textColor,
    defaultExpanded = !event.requestHeaders.isNullOrEmpty(),
    copyText = reqHeadersCopy,
  ) {
    val reqHeaders = event.requestHeaders
    if (!reqHeaders.isNullOrEmpty()) {
      HeaderDataTable(reqHeaders, textColor)
    } else {
      Text("No headers captured", fontSize = 9.sp, color = textColor.copy(alpha = 0.35f))
    }
  }

  Spacer(Modifier.height(8.dp))

  val respHeadersCopy =
    remember(event.responseHeaders) {
      event.responseHeaders?.entries?.joinToString("\n") { "${it.key}: ${it.value}" }
    }
  CollapsibleSection(
    "Response Headers",
    textColor,
    defaultExpanded = !event.responseHeaders.isNullOrEmpty(),
    copyText = respHeadersCopy,
  ) {
    val respHeaders = event.responseHeaders
    if (!respHeaders.isNullOrEmpty()) {
      HeaderDataTable(respHeaders, textColor)
    } else {
      Text("No headers captured", fontSize = 9.sp, color = textColor.copy(alpha = 0.35f))
    }
  }
}

@Composable
internal fun NetworkRequestTab(event: TelemetryDisplayEvent.Network, textColor: Color) {
  val reqSize = (event.requestHeaders?.get("Content-Length")?.toLongOrNull()) ?: -1
  CollapsibleSection(
    "Request Body",
    textColor,
    defaultExpanded = !event.requestBody.isNullOrBlank(),
    copyText = event.requestBody,
  ) {
    NetworkBodyContent(
      body = event.requestBody,
      contentType = event.requestHeaders?.get("Content-Type"),
      bodySize = reqSize,
      textColor = textColor,
    )
  }
}

@Composable
internal fun NetworkResponseTab(event: TelemetryDisplayEvent.Network, textColor: Color) {
  val respSize = (event.responseHeaders?.get("Content-Length")?.toLongOrNull()) ?: -1
  CollapsibleSection(
    "Response Body",
    textColor,
    defaultExpanded = !event.responseBody.isNullOrBlank(),
    copyText = event.responseBody,
  ) {
    NetworkBodyContent(
      body = event.responseBody,
      contentType = event.contentType,
      bodySize = respSize,
      textColor = textColor,
    )
  }
}

@Composable
internal fun NetworkReplayOverview(result: NetworkReplayResult, textColor: Color) {

  Spacer(Modifier.height(8.dp))
  Text(
    "Replay Result",
    fontSize = 10.sp,
    fontWeight = FontWeight.SemiBold,
    color = textColor.copy(alpha = 0.7f),
  )
  Spacer(Modifier.height(4.dp))
  DetailRow("Status", "${result.statusCode}", textColor)
  DetailRow("Duration", "${result.durationMs}ms", textColor)
  result.error?.let { DetailRow("Error", it, textColor) }
  val replayRespHeadersCopy =
    result.responseHeaders.entries.joinToString("\n") { "${it.key}: ${it.value}" }
  CollapsibleSection(
    "Response Headers",
    textColor,
    defaultExpanded = false,
    copyText = replayRespHeadersCopy,
  ) {
    if (result.responseHeaders.isNotEmpty()) {
      HeaderDataTable(result.responseHeaders, textColor)
    } else {
      Text("No headers", fontSize = 9.sp, color = textColor.copy(alpha = 0.35f))
    }
  }
  CollapsibleSection("Response Body", textColor, copyText = result.responseBody) {
    NetworkReplayBody(result, textColor)
  }
}

@Composable
internal fun NetworkReplayBody(result: NetworkReplayResult, textColor: Color) {

  val contentType =
    result.responseHeaders.entries.find { it.key.equals("content-type", ignoreCase = true) }?.value
  if (result.responseBodyBytes != null && contentType?.startsWith("image/") == true) {
    // Render image from raw bytes
    val bitmap =
      remember(result.responseBodyBytes) {
        try {
          org.jetbrains.skia.Image.makeFromEncoded(result.responseBodyBytes).toComposeImageBitmap()
        } catch (error: IllegalArgumentException) {
          dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory.getLogger("Telemetry")
            .debug("Invalid optional event data: ${error.message}")
          null
        }
      }
    if (bitmap != null) {
      Box(
        Modifier.fillMaxWidth()
          .background(textColor.copy(alpha = 0.05f), RoundedCornerShape(4.dp))
          .padding(8.dp),
      ) {
        Image(
          bitmap = bitmap,
          contentDescription = "Response image",
          modifier = Modifier.fillMaxWidth().heightIn(max = 400.dp),
          contentScale = ContentScale.Fit,
        )
      }
    } else {
      Text(
        "Image (${contentType}, ${formatByteSize(result.responseBodyBytes.size.toLong())})",
        fontSize = 9.sp,
        color = textColor.copy(alpha = 0.4f),
      )
    }
  } else {
    NetworkBodyContent(
      body = result.responseBody,
      contentType = contentType,
      bodySize =
        result.responseBody?.length?.toLong() ?: result.responseBodyBytes?.size?.toLong() ?: -1,
      textColor = textColor,
    )
  }
}
