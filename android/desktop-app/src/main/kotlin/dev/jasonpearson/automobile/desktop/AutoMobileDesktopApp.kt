@file:OptIn(
  androidx.compose.foundation.ExperimentalFoundationApi::class,
  androidx.compose.foundation.layout.ExperimentalLayoutApi::class,
)

package dev.jasonpearson.automobile.desktop

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BugReport
import androidx.compose.material.icons.filled.DeviceHub
import androidx.compose.material.icons.filled.Explore
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material.icons.filled.Science
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.mcp.BootedDevice
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceType
import dev.jasonpearson.automobile.desktop.theme.AutoMobileTheme

/** Dashboard tabs mirroring the IDE plugin's Dashboard enum. */
enum class Dashboard(val title: String, val icon: ImageVector) {
  Navigation("Navigation", Icons.Default.Explore),
  Test("Test", Icons.Default.Science),
  Performance("Performance", Icons.Default.Speed),
  Layout("Layout", Icons.Default.Layers),
  Storage("Storage", Icons.Default.Storage),
  Failures("Failures", Icons.Default.BugReport),
}

@Composable
fun AutoMobileDesktopApp() {
  AutoMobileTheme {
    Surface(
      modifier = Modifier.fillMaxSize(),
      color = MaterialTheme.colorScheme.surface,
    ) {
      var selectedDashboard by remember { mutableIntStateOf(0) }
      var connectionEndpoint by remember { mutableStateOf("http://localhost:3000/auto-mobile/streamable") }
      var isConnected by remember { mutableStateOf(false) }

      Row(modifier = Modifier.fillMaxSize()) {
        // Left navigation rail
        DashboardNavigationRail(
          selectedIndex = selectedDashboard,
          onSelected = { selectedDashboard = it },
        )

        VerticalDivider()

        // Main content area
        Column(modifier = Modifier.weight(1f)) {
          // Connection header
          ConnectionHeader(
            endpoint = connectionEndpoint,
            isConnected = isConnected,
            onEndpointChanged = { connectionEndpoint = it },
            onConnectClicked = { isConnected = !isConnected },
          )

          HorizontalDivider()

          // Dashboard content
          Box(modifier = Modifier.fillMaxSize()) {
            val dashboard = Dashboard.entries[selectedDashboard]
            DashboardContent(dashboard = dashboard, isConnected = isConnected)
          }
        }
      }
    }
  }
}

@Composable
private fun DashboardNavigationRail(
  selectedIndex: Int,
  onSelected: (Int) -> Unit,
) {
  NavigationRail(
    modifier = Modifier.fillMaxHeight(),
    containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f),
  ) {
    Spacer(modifier = Modifier.height(8.dp))
    Dashboard.entries.forEachIndexed { index, dashboard ->
      NavigationRailItem(
        selected = selectedIndex == index,
        onClick = { onSelected(index) },
        icon = { Icon(dashboard.icon, contentDescription = dashboard.title) },
        label = { Text(dashboard.title, fontSize = 10.sp) },
      )
    }
  }
}

@Composable
private fun ConnectionHeader(
  endpoint: String,
  isConnected: Boolean,
  onEndpointChanged: (String) -> Unit,
  onConnectClicked: () -> Unit,
) {
  Row(
    modifier = Modifier
      .fillMaxWidth()
      .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f))
      .padding(horizontal = 16.dp, vertical = 8.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.SpaceBetween,
  ) {
    Row(
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Icon(
        Icons.Default.DeviceHub,
        contentDescription = "Connection",
        modifier = Modifier.size(20.dp),
        tint = if (isConnected) {
          MaterialTheme.colorScheme.primary
        } else {
          MaterialTheme.colorScheme.onSurfaceVariant
        },
      )
      Text(
        text = if (isConnected) "Connected" else "Disconnected",
        style = MaterialTheme.typography.bodyMedium,
        fontWeight = FontWeight.Medium,
        color = if (isConnected) {
          MaterialTheme.colorScheme.primary
        } else {
          MaterialTheme.colorScheme.onSurfaceVariant
        },
      )
      Text(
        text = endpoint,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }

    Box(
      modifier = Modifier
        .clip(RoundedCornerShape(6.dp))
        .background(
          if (isConnected) {
            MaterialTheme.colorScheme.error
          } else {
            MaterialTheme.colorScheme.primary
          },
        )
        .clickable { onConnectClicked() }
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(horizontal = 16.dp, vertical = 6.dp),
    ) {
      Text(
        text = if (isConnected) "Disconnect" else "Connect",
        color = if (isConnected) {
          MaterialTheme.colorScheme.onError
        } else {
          MaterialTheme.colorScheme.onPrimary
        },
        fontSize = 13.sp,
        fontWeight = FontWeight.Medium,
      )
    }
  }
}

@Composable
private fun DashboardContent(dashboard: Dashboard, isConnected: Boolean) {
  if (!isConnected) {
    // Show connection prompt
    Box(
      modifier = Modifier.fillMaxSize(),
      contentAlignment = Alignment.Center,
    ) {
      Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
      ) {
        Icon(
          dashboard.icon,
          contentDescription = null,
          modifier = Modifier.size(64.dp),
          tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f),
        )
        Text(
          text = "Connect to AutoMobile daemon",
          style = MaterialTheme.typography.titleMedium,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
          text = "Click Connect above to start viewing ${dashboard.title.lowercase()} data",
          style = MaterialTheme.typography.bodyMedium,
          color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
        )
      }
    }
    return
  }

  // Connected - show dashboard placeholder
  when (dashboard) {
    Dashboard.Navigation -> DashboardPlaceholder(
      title = "Navigation Graph",
      description = "Visualize app navigation flows and screen transitions",
      icon = dashboard.icon,
    )
    Dashboard.Test -> DashboardPlaceholder(
      title = "Test Runs",
      description = "View test execution results, timings, and recordings",
      icon = dashboard.icon,
    )
    Dashboard.Performance -> DashboardPlaceholder(
      title = "Performance Metrics",
      description = "Monitor FPS, frame time, jank, memory, and recomposition rates",
      icon = dashboard.icon,
    )
    Dashboard.Layout -> DashboardPlaceholder(
      title = "Layout Inspector",
      description = "Inspect view hierarchy and element properties",
      icon = dashboard.icon,
    )
    Dashboard.Storage -> DashboardPlaceholder(
      title = "Storage Inspector",
      description = "Browse SharedPreferences, databases, and key-value stores",
      icon = dashboard.icon,
    )
    Dashboard.Failures -> DashboardPlaceholder(
      title = "Failures Dashboard",
      description = "Track crashes, ANRs, tool failures, and non-fatal errors",
      icon = dashboard.icon,
    )
  }
}

@Composable
private fun DashboardPlaceholder(
  title: String,
  description: String,
  icon: ImageVector,
) {
  Box(
    modifier = Modifier.fillMaxSize(),
    contentAlignment = Alignment.Center,
  ) {
    Column(
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Icon(
        icon,
        contentDescription = null,
        modifier = Modifier.size(48.dp),
        tint = MaterialTheme.colorScheme.primary.copy(alpha = 0.6f),
      )
      Text(
        text = title,
        style = MaterialTheme.typography.headlineSmall,
        fontWeight = FontWeight.SemiBold,
      )
      Text(
        text = description,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
  }
}
