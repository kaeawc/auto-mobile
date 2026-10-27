package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse
import kotlinx.coroutines.Dispatchers

data class DaemonStatusOptions(
  val dataSourceMode: DataSourceMode,
  val modifier: Modifier = Modifier,
  val statusProvider: (suspend () -> DaemonStatusResponse?)? = null,
  val providedSocketPath: String? = null,
  val refreshKey: Any? = null,
  val ioDispatcher: kotlinx.coroutines.CoroutineDispatcher = kotlinx.coroutines.Dispatchers.IO,
)
