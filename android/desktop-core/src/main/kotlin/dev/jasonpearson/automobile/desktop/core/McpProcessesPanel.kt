package dev.jasonpearson.automobile.desktop.core

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonLifecycleResult
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonNotificationClient
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonSocketPaths
import dev.jasonpearson.automobile.desktop.core.daemon.DesktopDaemonLifecycle
import dev.jasonpearson.automobile.desktop.core.daemon.McpDaemonClient
import dev.jasonpearson.automobile.desktop.core.daemon.McpHttpClient
import dev.jasonpearson.automobile.desktop.core.daemon.McpResource
import dev.jasonpearson.automobile.desktop.core.daemon.McpTool
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.mcp.FakeMcpProcessDetector
import dev.jasonpearson.automobile.desktop.core.mcp.McpConnectionType
import dev.jasonpearson.automobile.desktop.core.mcp.McpProcess
import dev.jasonpearson.automobile.desktop.core.mcp.RealMcpProcessDetector
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// Test result state
data class TestResult(
  val pid: Int,
  val success: Boolean,
  val latencyMs: Long? = null,
  val error: String? = null,
  val timestamp: Long = System.currentTimeMillis(),
)

@Composable
internal fun McpProcessesPanel(
  useRealData: Boolean = false,
  onDeviceSelected: (deviceId: String, deviceName: String?) -> Unit = { _, _ -> },
  onProcessConnected: (McpProcess?) -> Unit = {}, // Called when MCP process connection changes
  suppressAutoSelect: Boolean = false, // When true, don't auto-select device (user wants to browse)
) {
  val graph = LocalAutoMobileGraph.current
  val colors = SharedTheme.globalColors

  // Use appropriate detector based on mode
  val detector =
    remember(useRealData) {
      if (useRealData) RealMcpProcessDetector() else FakeMcpProcessDetector()
    }

  // Detect processes (with refresh capability)
  var refreshCounter by remember { mutableIntStateOf(0) }
  var processes by remember { mutableStateOf<List<McpProcess>>(emptyList()) }
  var isLoading by remember { mutableStateOf(true) }

  LaunchedEffect(useRealData, refreshCounter) {
    isLoading = true
    processes = detector.detectProcesses()
    isLoading = false
    LOG.debug(
      "[McpProcessesPanel] Detected ${processes.size} MCP processes (useRealData=$useRealData)"
    )
    processes.forEach { p ->
      LOG.debug(
        "[McpProcessesPanel]   - ${p.name} (PID ${p.pid}, ${p.connectionType}, socket=${p.socketPath}, port=${p.port})"
      )
    }
  }

  // State for connected server
  var connectedProcess by remember { mutableStateOf<McpProcess?>(null) }

  // Notify parent when connected process changes
  LaunchedEffect(connectedProcess) {
    LOG.debug(
      "[McpProcessesPanel] LaunchedEffect(connectedProcess) triggered, connectedProcess=${connectedProcess?.let { "${it.name} (PID ${it.pid})" } ?: "null"}"
    )
    onProcessConnected(connectedProcess)
  }

  // Auto-connect to the first Unix Socket process if there's only one
  LaunchedEffect(processes) {
    val socketProcesses = processes.filter { it.connectionType == McpConnectionType.UnixSocket }
    if (socketProcesses.size == 1 && connectedProcess == null) {
      val autoConnectProcess = socketProcesses.first()
      LOG.debug(
        "[McpProcessesPanel] Auto-connecting to ${autoConnectProcess.name} (PID ${autoConnectProcess.pid})"
      )
      connectedProcess = autoConnectProcess
      // Call directly - don't rely on LaunchedEffect(connectedProcess) which may not
      // fire before component is removed from composition due to device auto-selection
      onProcessConnected(autoConnectProcess)
    }
  }

  // State for details panel
  var detailsProcess by remember { mutableStateOf<McpProcess?>(null) }

  // State for test results
  var testResults by remember { mutableStateOf<Map<Int, TestResult>>(emptyMap()) }
  var testingPid by remember { mutableStateOf<Int?>(null) }

  // State for daemon spawning
  var isDaemonStarting by remember { mutableStateOf(false) }
  var daemonStartError by remember { mutableStateOf<String?>(null) }

  // State for device booting
  var bootingDeviceIds by remember { mutableStateOf<Set<String>>(emptySet()) }
  var bootErrors by remember { mutableStateOf<Map<String, String>>(emptyMap()) }

  // State for device selection
  var selectingDevice by remember {
    mutableStateOf<dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo?>(null)
  }
  var selectError by remember { mutableStateOf<String?>(null) }

  // State for killing devices
  var killingDeviceIds by remember { mutableStateOf<Set<String>>(emptySet()) }
  var killErrors by remember { mutableStateOf<Map<String, String>>(emptyMap()) }

  // State for daemon status
  var daemonStatus by remember {
    mutableStateOf<dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse?>(null)
  }

  // State for service updates
  var updatingServiceDeviceIds by remember { mutableStateOf<Set<String>>(emptySet()) }

  val scope = androidx.compose.runtime.rememberCoroutineScope()

  // State for devices (fetched from connected MCP server)
  var bootedDevices by remember {
    mutableStateOf<List<dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo>>(emptyList())
  }
  var deviceImages by remember {
    mutableStateOf<List<dev.jasonpearson.automobile.desktop.core.mcp.DeviceImageInfo>>(emptyList())
  }
  var devicesLoading by remember { mutableStateOf(false) }
  var devicesError by remember { mutableStateOf<String?>(null) }

  // Fetch devices when connected
  LaunchedEffect(connectedProcess) {
    val process = connectedProcess
    if (process != null) {
      if (
        process.connectionType == McpConnectionType.UnixSocket &&
          process.socketPath == DaemonSocketPaths.socketPath()
      ) {
        devicesLoading = true
        bootedDevices = emptyList()
        deviceImages = emptyList()
        when (
          val result =
            withContext(Dispatchers.IO) {
              DesktopDaemonLifecycle().ensureVersionMatchedDaemon()
            }
        ) {
          is DaemonLifecycleResult.Failure -> {
            daemonStartError = result.message
            devicesError = result.message
            devicesLoading = false
            return@LaunchedEffect
          }
          is DaemonLifecycleResult.Ready -> Unit
        }
      }
      devicesLoading = true
      devicesError = null
      try {
        LOG.debug(
          "[AutoMobile IDE] Creating MCP client for process: ${process.name}, type: ${process.connectionType}, socket: ${process.socketPath}, port: ${process.port}"
        )

        val client =
          if (useRealData) {
            dev.jasonpearson.automobile.desktop.core.mcp.McpResourceClientFactory.create(process)
          } else {
            dev.jasonpearson.automobile.desktop.core.mcp.McpResourceClientFactory.createFake()
          }

        LOG.debug("[AutoMobile IDE] Fetching booted devices from automobile:devices/booted")
        // Fetch booted devices
        when (val result = client.readResource("automobile:devices/booted")) {
          is dev.jasonpearson.automobile.desktop.core.mcp.ResourceReadResult.Success -> {
            LOG.debug(
              "[AutoMobile IDE] Successfully fetched booted devices: ${result.content.take(200)}..."
            )
            val parsed =
              dev.jasonpearson.automobile.desktop.core.mcp.DeviceResourceParser.parseBootedDevices(
                result.content
              )
            bootedDevices = parsed?.devices ?: emptyList()
            LOG.debug("[AutoMobile IDE] Parsed ${bootedDevices.size} booted devices")
          }
          is dev.jasonpearson.automobile.desktop.core.mcp.ResourceReadResult.Error -> {
            LOG.debug("[AutoMobile IDE] Error fetching booted devices: ${result.message}")
            devicesError = result.message
          }
        }

        LOG.debug("[AutoMobile IDE] Fetching device images from automobile:devices/images")
        // Fetch device images
        when (val result = client.readResource("automobile:devices/images")) {
          is dev.jasonpearson.automobile.desktop.core.mcp.ResourceReadResult.Success -> {
            LOG.debug(
              "[AutoMobile IDE] Successfully fetched device images: ${result.content.take(200)}..."
            )
            val parsed =
              dev.jasonpearson.automobile.desktop.core.mcp.DeviceResourceParser.parseDeviceImages(
                result.content
              )
            deviceImages = parsed?.images ?: emptyList()
            LOG.debug("[AutoMobile IDE] Parsed ${deviceImages.size} device images")
          }
          is dev.jasonpearson.automobile.desktop.core.mcp.ResourceReadResult.Error -> {
            LOG.debug("[AutoMobile IDE] Error fetching device images: ${result.message}")
            // Don't overwrite error from booted devices
            if (devicesError == null) devicesError = result.message
          }
        }

        client.close()

        // Fetch daemon status in background (best-effort)
        try {
          daemonStatus = graph.autoMobileClient.getDaemonStatus()
          LOG.debug("[AutoMobile IDE] Fetched daemon status: version=${daemonStatus?.version}")
        } catch (e: Exception) {
          LOG.debug("[AutoMobile IDE] Failed to fetch daemon status: ${e.message}")
        }
      } catch (e: Exception) {
        val stackTrace = e.stackTraceToString()
        LOG.debug("[AutoMobile IDE] Exception fetching devices: ${e.javaClass.name}: ${e.message}")
        LOG.debug("[AutoMobile IDE] Stack trace:\n$stackTrace")
        devicesError =
          "${e.javaClass.simpleName}: ${e.message}\n\nStack trace:\n${stackTrace.lines().take(5).joinToString("\n")}"
      }
      devicesLoading = false
    } else {
      // Clear device data when disconnected
      bootedDevices = emptyList()
      deviceImages = emptyList()
      devicesError = null
      daemonStatus = null
    }
  }

  // Auto-select the first device if there's only one (unless suppressed by user navigation)
  LaunchedEffect(bootedDevices, suppressAutoSelect) {
    if (!suppressAutoSelect && bootedDevices.size == 1 && selectingDevice == null) {
      val autoSelectDevice = bootedDevices.first()
      LOG.debug(
        "[McpProcessesPanel] Auto-selecting device: ${autoSelectDevice.name} (${autoSelectDevice.deviceId})"
      )
      selectingDevice = autoSelectDevice
      onDeviceSelected(autoSelectDevice.deviceId, autoSelectDevice.name)
      // Also set the active device on the MCP server
      kotlinx.coroutines.withContext(Dispatchers.IO) {
        try {
          graph.autoMobileClient.setActiveDevice(
            autoSelectDevice.deviceId,
            autoSelectDevice.platform,
          )
          LOG.debug(
            "[McpProcessesPanel] Auto-selected device on MCP server: ${autoSelectDevice.name}"
          )
        } catch (e: Exception) {
          LOG.warn("[McpProcessesPanel] Failed to set active device on MCP: ${e.message}")
        }
      }
    }
  }

  // Handlers
  val onConnect: (McpProcess) -> Unit = { process ->
    // Toggle: if already connected to this process, disconnect; otherwise connect
    val wasConnected = connectedProcess?.pid == process.pid
    connectedProcess = if (wasConnected) null else process
    LOG.debug("[McpProcessesPanel] Connect button clicked for ${process.name} (PID ${process.pid})")
    LOG.debug(
      "[McpProcessesPanel] ${if (wasConnected) "Disconnecting from" else "Connecting to"} process"
    )
    LOG.debug("[McpProcessesPanel] connectedProcess is now: ${connectedProcess?.name ?: "null"}")
  }

  val onDetails: (McpProcess) -> Unit = { process ->
    detailsProcess = if (detailsProcess?.pid == process.pid) null else process
  }

  val onTest: (McpProcess) -> Unit = { process -> testingPid = process.pid }

  val onStartDaemon: () -> Unit = {
    isDaemonStarting = true
    daemonStartError = null
  }

  // Launch daemon when requested
  LaunchedEffect(isDaemonStarting) {
    if (isDaemonStarting) {
      try {
        LOG.debug("[AutoMobile IDE] Starting daemon...")
        when (
          val result =
            withContext(Dispatchers.IO) {
              DesktopDaemonLifecycle().ensureVersionMatchedDaemon()
            }
        ) {
          is DaemonLifecycleResult.Ready -> {
            LOG.debug("[AutoMobile IDE] Daemon started with a matching version")
            refreshCounter++
          }
          is DaemonLifecycleResult.Failure -> {
            LOG.debug("[AutoMobile IDE] Daemon start failed: ${result.message}")
            daemonStartError = result.message
          }
        }
      } catch (e: Exception) {
        LOG.debug("[AutoMobile IDE] Exception starting daemon: ${e.message}")
        e.printStackTrace()
        daemonStartError = "Error starting daemon: ${e.message}"
      }
      isDaemonStarting = false
    }
  }

  // Boot device action (non-blocking coroutine)
  val onBootDeviceAction: (dev.jasonpearson.automobile.desktop.core.mcp.DeviceImageInfo) -> Unit =
    { image ->
      val deviceKey = image.deviceId ?: image.name
      bootingDeviceIds = bootingDeviceIds + deviceKey
      bootErrors = bootErrors - deviceKey
      scope.launch(Dispatchers.IO) {
        try {
          LOG.debug("[AutoMobile IDE] Booting device: ${image.name}")
          val result =
            graph.autoMobileClient.startDevice(
              name = image.name,
              platform = image.platform,
              deviceId = image.deviceId,
            )
          if (result.success) {
            LOG.debug("[AutoMobile IDE] Device booted successfully: ${image.name}")
            kotlinx.coroutines.delay(3000)
            refreshCounter++
          } else {
            LOG.debug("[AutoMobile IDE] Failed to boot device: ${result.message}")
            bootErrors = bootErrors + (deviceKey to (result.message ?: "Failed to boot"))
          }
        } catch (e: Exception) {
          LOG.debug("[AutoMobile IDE] Exception booting device: ${e.message}")
          bootErrors = bootErrors + (deviceKey to (e.message ?: "Error booting device"))
        }
        bootingDeviceIds = bootingDeviceIds - deviceKey
      }
    }

  // Select device action (non-blocking coroutine)
  val onSelectDeviceAction:
    (dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo) -> Unit =
    { device ->
      LOG.debug(
        "[AutoMobile IDE] Select clicked for device: ${device.name}, deviceId: ${device.deviceId}, platform: ${device.platform}"
      )
      selectingDevice = device
      selectError = null
      onDeviceSelected(device.deviceId, device.name)
      scope.launch(Dispatchers.IO) {
        try {
          val result = graph.autoMobileClient.setActiveDevice(device.deviceId, device.platform)
          if (result.success) {
            LOG.debug("[AutoMobile IDE] Device selected successfully: ${device.name}")
            selectError = null
          } else {
            LOG.debug("[AutoMobile IDE] Failed to select device: ${result.message}")
            selectError = result.message
          }
        } catch (e: Exception) {
          LOG.debug("[AutoMobile IDE] Exception selecting device: ${e.message}")
          selectError = e.message ?: "Error selecting device"
        }
        selectingDevice = null
      }
    }

  // Kill device action (non-blocking coroutine)
  val onKillDeviceAction: (dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo) -> Unit =
    { device ->
      killingDeviceIds = killingDeviceIds + device.deviceId
      killErrors = killErrors - device.deviceId
      scope.launch(Dispatchers.IO) {
        try {
          LOG.warn(
            "[AutoMobile IDE] Killing device: ${device.name} (${device.deviceId}, ${device.platform})"
          )
          val result =
            graph.autoMobileClient.killDevice(
              name = device.name,
              deviceId = device.deviceId,
              platform = device.platform,
            )
          if (result.success) {
            LOG.warn("[AutoMobile IDE] Device killed successfully: ${device.name}")
            kotlinx.coroutines.delay(2000)
            refreshCounter++
          } else {
            LOG.warn("[AutoMobile IDE] Failed to kill device: ${result.message}")
            killErrors = killErrors + (device.deviceId to (result.message ?: "Failed to kill"))
          }
        } catch (e: Exception) {
          LOG.warn("[AutoMobile IDE] Exception killing device: ${e.javaClass.name}: ${e.message}")
          killErrors = killErrors + (device.deviceId to (e.message ?: "Error killing device"))
        }
        killingDeviceIds = killingDeviceIds - device.deviceId
      }
    }

  // Update service action (non-blocking coroutine)
  val onUpdateServiceAction:
    (dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo) -> Unit =
    { device ->
      updatingServiceDeviceIds = updatingServiceDeviceIds + device.deviceId
      scope.launch(Dispatchers.IO) {
        try {
          LOG.warn(
            "[AutoMobile IDE] Updating service for device: ${device.name} (${device.deviceId}, ${device.platform})"
          )
          val result = graph.autoMobileClient.updateService(device.deviceId, device.platform)
          if (result.success) {
            LOG.warn("[AutoMobile IDE] Service updated successfully for: ${device.name}")
            kotlinx.coroutines.delay(1000)
            refreshCounter++
          } else {
            LOG.warn("[AutoMobile IDE] Failed to update service: ${result.message}")
          }
        } catch (e: Exception) {
          LOG.warn("[AutoMobile IDE] Exception updating service: ${e.javaClass.name}: ${e.message}")
        }
        updatingServiceDeviceIds = updatingServiceDeviceIds - device.deviceId
      }
    }

  // Handle test execution via LaunchedEffect
  LaunchedEffect(testingPid) {
    if (testingPid != null) {
      kotlinx.coroutines.delay(500) // Simulate network latency
      val success = (0..10).random() > 2 // 80% success rate for demo
      val result =
        if (success) {
          TestResult(
            pid = testingPid!!,
            success = true,
            latencyMs = (20..150).random().toLong(),
          )
        } else {
          TestResult(
            pid = testingPid!!,
            success = false,
            error = "Connection refused",
          )
        }
      testResults = testResults + (testingPid!! to result)
      testingPid = null
    }
  }

  // Group by connection type
  val streamableProcesses = processes.filter {
    it.connectionType == McpConnectionType.StreamableHttp
  }
  val socketProcesses = processes.filter { it.connectionType == McpConnectionType.UnixSocket }
  val stdioProcesses = processes.filter { it.connectionType == McpConnectionType.Stdio }

  LOG.debug(
    "[McpProcessesPanel] Process breakdown: streamable=${streamableProcesses.size}, socket=${socketProcesses.size}, stdio=${stdioProcesses.size}"
  )

  val scrollState = rememberScrollState()

  Column(
    modifier =
      Modifier.fillMaxWidth()
        .verticalScroll(scrollState)
        .background(colors.text.normal.copy(alpha = 0.02f))
        .padding(12.dp),
    verticalArrangement = Arrangement.spacedBy(16.dp),
  ) {
    // Header with Start Daemon button
    if (useRealData && socketProcesses.isEmpty() && !isDaemonStarting) {
      Box(
        modifier =
          Modifier.background(Color(0xFF4CAF50).copy(alpha = 0.15f), RoundedCornerShape(4.dp))
            .clickable { onStartDaemon() }
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(horizontal = 8.dp, vertical = 4.dp)
      ) {
        Text(
          "Start Daemon",
          fontSize = 10.sp,
          color = Color(0xFF4CAF50),
        )
      }
    }
    if (isDaemonStarting) {
      Text(
        "Starting...",
        fontSize = 10.sp,
        color = Color(0xFF2196F3),
      )
    }

    // Daemon start error
    if (daemonStartError != null) {
      Row(
        modifier =
          Modifier.fillMaxWidth()
            .background(Color(0xFFE53935).copy(alpha = 0.1f), RoundedCornerShape(6.dp))
            .padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text("⚠", fontSize = 14.sp, color = Color(0xFFE53935))
        Text(
          daemonStartError!!,
          fontSize = 11.sp,
          color = Color(0xFFE53935),
          modifier = Modifier.weight(1f),
          maxLines = 2,
          overflow = TextOverflow.Ellipsis,
        )
        Text(
          "✕",
          fontSize = 14.sp,
          color = Color(0xFFE53935).copy(alpha = 0.5f),
          modifier =
            Modifier.clickable { daemonStartError = null }.pointerHoverIcon(PointerIcon.Hand),
        )
      }
    }

    if (isLoading && processes.isEmpty()) {
      Box(
        modifier = Modifier.fillMaxWidth().padding(32.dp),
        contentAlignment = Alignment.Center,
      ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
          Text("⟳", fontSize = 24.sp, color = Color(0xFF2196F3))
          Text(
            "Detecting MCP servers...",
            fontSize = 12.sp,
            color = colors.text.normal.copy(alpha = 0.5f),
            modifier = Modifier.padding(top = 8.dp),
          )
        }
      }
    } else if (processes.isEmpty()) {
      Box(
        modifier = Modifier.fillMaxWidth().padding(32.dp),
        contentAlignment = Alignment.Center,
      ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
          Text(if (useRealData) "🔍" else "📋", fontSize = 24.sp)
          Text(
            if (useRealData) "No AutoMobile servers detected" else "Mock MCP Servers",
            fontSize = 12.sp,
            color = colors.text.normal.copy(alpha = 0.5f),
            modifier = Modifier.padding(top = 8.dp),
          )
          if (useRealData) {
            Text(
              "Start a daemon to enable MCP features",
              fontSize = 10.sp,
              color = colors.text.normal.copy(alpha = 0.4f),
              modifier = Modifier.padding(top = 4.dp),
            )
            Row(
              horizontalArrangement = Arrangement.spacedBy(8.dp),
              modifier = Modifier.padding(top = 12.dp),
            ) {
              Box(
                modifier =
                  Modifier.background(
                      Color(0xFF4CAF50).copy(alpha = 0.15f),
                      RoundedCornerShape(4.dp),
                    )
                    .clickable(enabled = !isDaemonStarting) { onStartDaemon() }
                    .pointerHoverIcon(
                      if (isDaemonStarting) PointerIcon.Default else PointerIcon.Hand
                    )
                    .padding(horizontal = 12.dp, vertical = 6.dp)
              ) {
                Text(
                  if (isDaemonStarting) "Starting..." else "Start Daemon",
                  fontSize = 11.sp,
                  color = Color(0xFF4CAF50),
                )
              }
              Text(
                "↻ Refresh",
                fontSize = 10.sp,
                color = Color(0xFF2196F3),
                modifier =
                  Modifier.clickable { refreshCounter++ }.pointerHoverIcon(PointerIcon.Hand),
              )
            }
          } else {
            Text(
              "Switch to Real mode to detect actual servers",
              fontSize = 10.sp,
              color = colors.text.normal.copy(alpha = 0.4f),
              modifier = Modifier.padding(top = 4.dp),
            )
          }
        }
      }
    } else {
      // Streamable HTTP servers
      if (streamableProcesses.isNotEmpty()) {
        ProcessSection(
          title = "Streamable HTTP",
          icon = "🌐",
          processes = streamableProcesses,
          connectedPid = connectedProcess?.pid,
          testResults = testResults,
          testingPid = testingPid,
          detailsPid = detailsProcess?.pid,
          onConnect = onConnect,
          onDetails = onDetails,
          onTest = onTest,
        )
      }

      // Unix Socket servers
      if (socketProcesses.isNotEmpty()) {
        ProcessSection(
          title = "Unix Socket",
          icon = "🔌",
          processes = socketProcesses,
          connectedPid = connectedProcess?.pid,
          testResults = testResults,
          testingPid = testingPid,
          detailsPid = detailsProcess?.pid,
          onConnect = onConnect,
          onDetails = onDetails,
          onTest = onTest,
        )
      }

      // Devices section (when connected)
      LOG.debug(
        "[McpProcessesPanel] connectedProcess=$connectedProcess, bootedDevices.size=${bootedDevices.size}"
      )
      if (connectedProcess != null) {
        LOG.debug("[McpProcessesPanel] Showing DevicesSection")
        DevicesSection(
          bootedDevices = bootedDevices,
          deviceImages = deviceImages,
          isLoading = devicesLoading,
          error = devicesError,
          bootingDeviceIds = bootingDeviceIds,
          killingDeviceIds = killingDeviceIds,
          bootErrors = bootErrors,
          killErrors = killErrors,
          daemonStatus = daemonStatus,
          updatingServiceDeviceIds = updatingServiceDeviceIds,
          onSelectDevice = onSelectDeviceAction,
          onBootDevice = onBootDeviceAction,
          onKillDevice = onKillDeviceAction,
          onUpdateService = onUpdateServiceAction,
        )
      }

      // Potential ports info
      Box(
        modifier =
          Modifier.fillMaxWidth()
            .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(6.dp))
            .padding(12.dp)
      ) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
          Text(
            "Connection Info",
            fontSize = 11.sp,
            maxLines = 1,
            softWrap = false,
            fontWeight = androidx.compose.ui.text.font.FontWeight.Medium,
            color = colors.text.normal.copy(alpha = 0.7f),
          )
          Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Column {
              Text(
                "Active Ports",
                fontSize = 9.sp,
                maxLines = 1,
                softWrap = false,
                color = colors.text.normal.copy(alpha = 0.5f),
              )
              Text(
                streamableProcesses
                  .mapNotNull { it.port }
                  .joinToString(", ") { ":$it" }
                  .ifEmpty { "None" },
                fontSize = 11.sp,
                color = colors.text.normal,
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.Ellipsis,
              )
            }
            Column {
              Text(
                "Socket Paths",
                fontSize = 9.sp,
                maxLines = 1,
                softWrap = false,
                color = colors.text.normal.copy(alpha = 0.5f),
              )
              Text(
                socketProcesses.mapNotNull { it.socketPath }.joinToString(", ").ifEmpty { "None" },
                fontSize = 11.sp,
                color = colors.text.normal,
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.Ellipsis,
              )
            }
          }
        }
      }
    }
  }
}

@Composable
private fun ProcessSection(
  title: String,
  icon: String,
  processes: List<McpProcess>,
  connectedPid: Int?,
  testResults: Map<Int, TestResult>,
  testingPid: Int?,
  detailsPid: Int?,
  onConnect: (McpProcess) -> Unit,
  onDetails: (McpProcess) -> Unit,
  onTest: (McpProcess) -> Unit,
) {
  val colors = SharedTheme.globalColors

  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Row(
      horizontalArrangement = Arrangement.spacedBy(6.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(icon, fontSize = 12.sp)
      Text(
        title,
        fontSize = 11.sp,
        maxLines = 1,
        softWrap = false,
        fontWeight = androidx.compose.ui.text.font.FontWeight.Medium,
        color = colors.text.normal.copy(alpha = 0.7f),
      )
      Box(
        modifier =
          Modifier.background(Color(0xFF4CAF50).copy(alpha = 0.2f), RoundedCornerShape(4.dp))
            .padding(horizontal = 6.dp, vertical = 2.dp)
      ) {
        Text(
          "${processes.size}",
          fontSize = 9.sp,
          color = Color(0xFF4CAF50),
        )
      }
    }

    processes.forEach { process ->
      McpProcessItem(
        process = process,
        isConnected = connectedPid == process.pid,
        testResult = testResults[process.pid],
        isTesting = testingPid == process.pid,
        showDetails = detailsPid == process.pid,
        onConnect = onConnect,
        onDetails = onDetails,
        onTest = onTest,
      )
    }
  }
}

@Composable
private fun McpProcessItem(
  process: McpProcess,
  isConnected: Boolean = false,
  testResult: TestResult? = null,
  isTesting: Boolean = false,
  showDetails: Boolean = false,
  onConnect: (McpProcess) -> Unit = {},
  onDetails: (McpProcess) -> Unit = {},
  onTest: (McpProcess) -> Unit = {},
) {
  val colors = SharedTheme.globalColors
  val uptimeText = formatUptime(process.uptimeMs)

  BoxWithConstraints {
    val isCompressed = maxWidth < 300.dp
    Column {
      Row(
        modifier =
          Modifier.fillMaxWidth()
            .background(
              if (isConnected) Color(0xFF4CAF50).copy(alpha = 0.1f)
              else colors.text.normal.copy(alpha = 0.05f),
              RoundedCornerShape(
                topStart = 6.dp,
                topEnd = 6.dp,
                bottomStart = if (showDetails) 0.dp else 6.dp,
                bottomEnd = if (showDetails) 0.dp else 6.dp,
              ),
            )
            .then(
              if (isConnected)
                Modifier.border(
                  1.dp,
                  Color(0xFF4CAF50).copy(alpha = 0.3f),
                  RoundedCornerShape(
                    topStart = 6.dp,
                    topEnd = 6.dp,
                    bottomStart = if (showDetails) 0.dp else 6.dp,
                    bottomEnd = if (showDetails) 0.dp else 6.dp,
                  ),
                )
              else Modifier
            )
            .padding(10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        // Status indicator
        Box(
          modifier =
            Modifier.size(8.dp)
              .background(
                if (isConnected) Color(0xFF4CAF50) else Color(0xFF4CAF50).copy(alpha = 0.5f),
                CircleShape,
              )
        )

        // Process info
        Column(modifier = Modifier.weight(1f)) {
          Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
          ) {
            Text(
              process.name,
              fontSize = 12.sp,
              fontWeight = androidx.compose.ui.text.font.FontWeight.Medium,
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
            )
            Text(
              "PID ${process.pid}",
              fontSize = 10.sp,
              maxLines = 1,
              softWrap = false,
              color = colors.text.normal.copy(alpha = 0.5f),
            )
            if (isConnected) {
              Text(
                "● Active",
                fontSize = 9.sp,
                maxLines = 1,
                softWrap = false,
                color = Color(0xFF4CAF50),
              )
            }
          }
          Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
          ) {
            when (process.connectionType) {
              McpConnectionType.StreamableHttp -> {
                Text(
                  "http://localhost:${process.port}",
                  fontSize = 10.sp,
                  color = Color(0xFF2196F3),
                  maxLines = 1,
                  overflow = TextOverflow.Ellipsis,
                )
              }
              McpConnectionType.UnixSocket -> {
                Text(
                  process.socketPath ?: "Unknown socket",
                  fontSize = 10.sp,
                  color = Color(0xFF9C27B0),
                  maxLines = 1,
                  overflow = TextOverflow.Ellipsis,
                )
              }
              McpConnectionType.Stdio -> {
                Text(
                  "Standard I/O",
                  fontSize = 10.sp,
                  maxLines = 1,
                  softWrap = false,
                  color = Color(0xFFFF9800),
                )
              }
            }
            Text(
              "•",
              fontSize = 10.sp,
              maxLines = 1,
              softWrap = false,
              color = colors.text.normal.copy(alpha = 0.3f),
            )
            Text(
              "Up $uptimeText",
              fontSize = 10.sp,
              maxLines = 1,
              softWrap = false,
              color = colors.text.normal.copy(alpha = 0.5f),
            )

            // Test result indicator
            if (isTesting) {
              Text(
                "Testing...",
                fontSize = 10.sp,
                maxLines = 1,
                softWrap = false,
                color = Color(0xFF2196F3),
              )
            } else if (testResult != null) {
              Text(
                "•",
                fontSize = 10.sp,
                maxLines = 1,
                softWrap = false,
                color = colors.text.normal.copy(alpha = 0.3f),
              )
              if (testResult.success) {
                Text(
                  "✓ ${testResult.latencyMs}ms",
                  fontSize = 10.sp,
                  maxLines = 1,
                  softWrap = false,
                  color = Color(0xFF4CAF50),
                )
              } else {
                Text(
                  "✗ ${testResult.error}",
                  fontSize = 10.sp,
                  color = Color(0xFFE53935),
                  maxLines = 1,
                  overflow = TextOverflow.Ellipsis,
                )
              }
            }
          }
        }

        // Action buttons
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
          // Test button
          Box(
            modifier =
              Modifier.background(
                  when {
                    isTesting -> Color(0xFF2196F3).copy(alpha = 0.15f)
                    testResult?.success == true -> Color(0xFF4CAF50).copy(alpha = 0.1f)
                    testResult?.success == false -> Color(0xFFE53935).copy(alpha = 0.1f)
                    else -> colors.text.normal.copy(alpha = 0.08f)
                  },
                  RoundedCornerShape(4.dp),
                )
                .clickable(enabled = !isTesting) { onTest(process) }
                .pointerHoverIcon(if (isTesting) PointerIcon.Default else PointerIcon.Hand)
                .padding(horizontal = 8.dp, vertical = 6.dp)
          ) {
            Text(
              when {
                isTesting -> "..."
                isCompressed -> "🧪"
                else -> "Test"
              },
              fontSize = 10.sp,
              maxLines = 1,
              softWrap = false,
              color =
                when {
                  isTesting -> Color(0xFF2196F3)
                  testResult?.success == true -> Color(0xFF4CAF50)
                  testResult?.success == false -> Color(0xFFE53935)
                  else -> colors.text.normal.copy(alpha = 0.7f)
                },
            )
          }

          // Details button
          Box(
            modifier =
              Modifier.background(
                  if (showDetails) Color(0xFF9C27B0).copy(alpha = 0.25f)
                  else Color(0xFF9C27B0).copy(alpha = 0.15f),
                  RoundedCornerShape(4.dp),
                )
                .clickable { onDetails(process) }
                .pointerHoverIcon(PointerIcon.Hand)
                .padding(horizontal = 8.dp, vertical = 6.dp)
          ) {
            Text(
              if (isCompressed) "📋" else if (showDetails) "Hide" else "Details",
              fontSize = 10.sp,
              maxLines = 1,
              softWrap = false,
              color = Color(0xFF9C27B0),
            )
          }

          // Connect toggle button
          Box(
            modifier =
              Modifier.background(
                  if (isConnected) Color(0xFF4CAF50).copy(alpha = 0.3f)
                  else Color(0xFF4CAF50).copy(alpha = 0.15f),
                  RoundedCornerShape(4.dp),
                )
                .clickable {
                  LOG.debug("[McpProcessItem] Connect button clicked for ${process.name}")
                  onConnect(process)
                }
                .pointerHoverIcon(PointerIcon.Hand)
                .padding(horizontal = 8.dp, vertical = 6.dp)
          ) {
            Text(
              when {
                isCompressed && isConnected -> "✓"
                isCompressed -> "🔌"
                isConnected -> "Connected ✓"
                else -> "Connect"
              },
              fontSize = 10.sp,
              maxLines = 1,
              softWrap = false,
              color = Color(0xFF4CAF50),
            )
          }
        }
      }

      // Details panel
      if (showDetails) {
        McpProcessDetails(process = process)
      }
    }
  }
}

@Composable
private fun McpProcessDetails(process: McpProcess) {
  val colors = SharedTheme.globalColors
  var resources by remember { mutableStateOf<List<McpResource>?>(null) }
  var tools by remember { mutableStateOf<List<McpTool>?>(null) }
  var resourcesExpanded by remember { mutableStateOf(false) }
  var toolsExpanded by remember { mutableStateOf(false) }
  var error by remember { mutableStateOf<String?>(null) }
  var refreshToken by remember { mutableStateOf(0) }

  // Only a Unix-socket process has a control socket to subscribe on; HTTP/STDIO processes keep
  // the previous fetch-once behaviour.
  val notifications =
    remember(process.pid, process.socketPath) {
      val socketPath = process.socketPath
      if (process.connectionType == McpConnectionType.UnixSocket && !socketPath.isNullOrBlank()) {
        DaemonNotificationClient(socketPathValue = socketPath)
      } else {
        null
      }
    }

  DisposableEffect(notifications) { onDispose { notifications?.dispose() } }

  // Refetch when the daemon says the lists changed. A daemon that predates the subscription
  // reports Unsupported and never emits, so the fetch-once behaviour is untouched there.
  LaunchedEffect(notifications) {
    if (notifications == null) return@LaunchedEffect
    notifications.connect()
    notifications.notifications.collect { refreshToken += 1 }
  }

  // Fetch resources and tools from MCP server
  LaunchedEffect(process.pid, refreshToken) {
    kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
      try {
        kotlinx.coroutines.withTimeout(5000) {
          val client =
            when (process.connectionType) {
              McpConnectionType.StreamableHttp ->
                McpHttpClient("http://localhost:${process.port}/auto-mobile/streamable")
              McpConnectionType.UnixSocket -> McpDaemonClient(process.socketPath ?: "")
              McpConnectionType.Stdio -> null // STDIO shouldn't appear
            }

          if (client != null) {
            val fetchedResources = client.listResources()
            val fetchedTools = client.listTools()
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
              resources = fetchedResources
              tools = fetchedTools
              error = null
            }
          }
        }
      } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
          error = "Timeout fetching data (5s)"
        }
      } catch (e: Exception) {
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
          error = "Failed: ${e.message}"
        }
      }
    }
  }

  Column(
    modifier =
      Modifier.fillMaxWidth()
        .background(
          colors.text.normal.copy(alpha = 0.03f),
          RoundedCornerShape(bottomStart = 6.dp, bottomEnd = 6.dp),
        )
        .padding(12.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    // Connection details
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
      Text(
        "Connection",
        fontSize = 11.sp,
        maxLines = 1,
        softWrap = false,
        fontWeight = androidx.compose.ui.text.font.FontWeight.Medium,
        color = colors.text.normal.copy(alpha = 0.7f),
      )
      Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        Column {
          Text(
            "Type",
            fontSize = 9.sp,
            maxLines = 1,
            softWrap = false,
            color = colors.text.normal.copy(alpha = 0.5f),
          )
          Text(process.connectionType.label, fontSize = 11.sp, maxLines = 1, softWrap = false)
        }
        Column {
          Text(
            "Endpoint",
            fontSize = 9.sp,
            maxLines = 1,
            softWrap = false,
            color = colors.text.normal.copy(alpha = 0.5f),
          )
          Text(
            when (process.connectionType) {
              McpConnectionType.StreamableHttp -> "http://localhost:${process.port}"
              McpConnectionType.UnixSocket -> process.socketPath ?: "Unknown"
              McpConnectionType.Stdio -> "stdin/stdout"
            },
            fontSize = 11.sp,
            maxLines = 1,
            softWrap = false,
            overflow = TextOverflow.Ellipsis,
          )
        }
        Column {
          Text(
            "PID",
            fontSize = 9.sp,
            maxLines = 1,
            softWrap = false,
            color = colors.text.normal.copy(alpha = 0.5f),
          )
          Text("${process.pid}", fontSize = 11.sp, maxLines = 1, softWrap = false)
        }
      }
    }

    // Resources
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
      val currentError = error
      val currentResources = resources
      val currentResourcesExpanded = resourcesExpanded

      Row(
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth(),
      ) {
        Text(
          "Resources",
          fontSize = 11.sp,
          maxLines = 1,
          softWrap = false,
          fontWeight = androidx.compose.ui.text.font.FontWeight.Medium,
          color = colors.text.normal.copy(alpha = 0.7f),
        )
        if (currentResources != null && currentResources.size > 5) {
          Text(
            if (currentResourcesExpanded) "Collapse" else "Expand all",
            fontSize = 9.sp,
            color = Color(0xFF2196F3),
            modifier =
              Modifier.clickable { resourcesExpanded = !resourcesExpanded }
                .pointerHoverIcon(PointerIcon.Hand)
                .padding(horizontal = 4.dp),
          )
        }
      }
      if (currentError != null) {
        Text(currentError, fontSize = 9.sp, color = Color(0xFFE53935))
      } else if (currentResources == null) {
        Text("Loading...", fontSize = 9.sp, color = colors.text.normal.copy(alpha = 0.5f))
      } else if (currentResources.isEmpty()) {
        Text("No resources", fontSize = 9.sp, color = colors.text.normal.copy(alpha = 0.5f))
      } else {
        val resourcesToShow =
          if (currentResourcesExpanded) currentResources else currentResources.take(5)
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
          resourcesToShow.forEach { resource ->
            Box(
              modifier =
                Modifier.background(
                    Color(0xFF2196F3).copy(alpha = 0.1f),
                    RoundedCornerShape(4.dp),
                  )
                  .padding(horizontal = 6.dp, vertical = 3.dp)
            ) {
              Text(resource.uri, fontSize = 9.sp, color = Color(0xFF2196F3))
            }
          }
          if (!currentResourcesExpanded && currentResources.size > 5) {
            Text(
              "+${currentResources.size - 5} more",
              fontSize = 9.sp,
              color = Color(0xFF2196F3),
              modifier =
                Modifier.clickable { resourcesExpanded = true }
                  .pointerHoverIcon(PointerIcon.Hand)
                  .padding(horizontal = 4.dp),
            )
          }
        }
      }
    }

    // Tools
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
      val currentError = error
      val currentTools = tools
      val currentToolsExpanded = toolsExpanded

      Row(
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth(),
      ) {
        Text(
          "Tools",
          fontSize = 11.sp,
          maxLines = 1,
          softWrap = false,
          fontWeight = androidx.compose.ui.text.font.FontWeight.Medium,
          color = colors.text.normal.copy(alpha = 0.7f),
        )
        if (currentTools != null && currentTools.size > 8) {
          Text(
            if (currentToolsExpanded) "Collapse" else "Expand all",
            fontSize = 9.sp,
            color = Color(0xFF9C27B0),
            modifier =
              Modifier.clickable { toolsExpanded = !toolsExpanded }
                .pointerHoverIcon(PointerIcon.Hand)
                .padding(horizontal = 4.dp),
          )
        }
      }
      if (currentError != null) {
        Text(currentError, fontSize = 9.sp, color = Color(0xFFE53935))
      } else if (currentTools == null) {
        Text("Loading...", fontSize = 9.sp, color = colors.text.normal.copy(alpha = 0.5f))
      } else if (currentTools.isEmpty()) {
        Text("No tools", fontSize = 9.sp, color = colors.text.normal.copy(alpha = 0.5f))
      } else {
        val toolsToShow = if (currentToolsExpanded) currentTools else currentTools.take(8)
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
          toolsToShow.chunked(4).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
              row.forEach { tool ->
                Box(
                  modifier =
                    Modifier.background(
                        Color(0xFF9C27B0).copy(alpha = 0.1f),
                        RoundedCornerShape(4.dp),
                      )
                      .padding(horizontal = 6.dp, vertical = 3.dp)
                ) {
                  Text(tool.name, fontSize = 9.sp, color = Color(0xFF9C27B0))
                }
              }
            }
          }
          if (!currentToolsExpanded && currentTools.size > 8) {
            Text(
              "+${currentTools.size - 8} more",
              fontSize = 9.sp,
              color = Color(0xFF9C27B0),
              modifier =
                Modifier.clickable { toolsExpanded = true }
                  .pointerHoverIcon(PointerIcon.Hand)
                  .padding(horizontal = 4.dp),
            )
          }
        }
      }
    }
  }
}

private fun formatUptime(ms: Long): String {
  return when {
    ms < 60_000 -> "${ms / 1000}s"
    ms < 3600_000 -> "${ms / 60_000}m"
    ms < 86400_000 -> "${ms / 3600_000}h ${(ms % 3600_000) / 60_000}m"
    else -> "${ms / 86400_000}d"
  }
}
