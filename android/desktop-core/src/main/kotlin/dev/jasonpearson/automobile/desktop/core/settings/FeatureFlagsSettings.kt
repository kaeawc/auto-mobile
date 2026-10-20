package dev.jasonpearson.automobile.desktop.core.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.FeatureFlagState
import dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import java.io.IOException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

// ── Feature Flags ────────────────────────────────────────────────────────

private val ACCESSIBILITY_LEVELS = listOf("A", "AA", "AAA")
private val ACCESSIBILITY_FAILURE_MODES = listOf("report", "threshold", "strict")
private val ACCESSIBILITY_SEVERITIES = listOf("error", "warning", "info")

private data class FeatureFlagsUiState(
  val statusText: String = "Loading feature flags...",
  val errorText: String? = null,
  val flags: List<FeatureFlagState> = emptyList(),
  val updatingKeys: Set<String> = emptySet(),
  val isLoading: Boolean = true,
)

private class FeatureFlagsViewModel(
  private val client: AutoMobileClient,
  ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
  private val scope = CoroutineScope(SupervisorJob() + ioDispatcher)
  private val _state = MutableStateFlow(FeatureFlagsUiState())
  val state: StateFlow<FeatureFlagsUiState> = _state.asStateFlow()

  fun loadFlags() {
    _state.update {
      it.copy(statusText = "Loading feature flags...", errorText = null, isLoading = true)
    }
    scope.launch {
      request(
        onError = { error ->
          _state.update {
            it.copy(
              flags = emptyList(),
              statusText = "Unable to load feature flags",
              errorText = error.message,
              isLoading = false,
            )
          }
        },
      ) {
        val flags = client.listFeatureFlags()
        _state.update {
          it.copy(
            flags = flags,
            statusText = "Loaded ${flags.size} flags",
            errorText = null,
            isLoading = false,
          )
        }
      }
    }
  }

  fun toggleFlag(flag: FeatureFlagState, enabled: Boolean) {
    val previous = _state.value.flags
    _state.update {
      it.copy(
        flags = it.flags.map { e -> if (e.key == flag.key) e.copy(enabled = enabled) else e },
        updatingKeys = it.updatingKeys + flag.key,
      )
    }
    scope.launch {
      request(
        onError = { error ->
          _state.update {
            it.copy(
              flags = previous,
              statusText = "Update failed",
              errorText = error.message,
              updatingKeys = it.updatingKeys - flag.key,
            )
          }
        },
      ) {
        val updated = client.setFeatureFlag(flag.key, enabled)
        _state.update {
          it.copy(
            flags = it.flags.map { e -> if (e.key == flag.key) updated else e },
            statusText = "Updated ${flag.label}",
            updatingKeys = it.updatingKeys - flag.key,
          )
        }
      }
    }
  }

  fun updateFlagConfig(flag: FeatureFlagState, config: JsonObject) {
    val previous = _state.value.flags
    _state.update {
      it.copy(
        flags = it.flags.map { e -> if (e.key == flag.key) e.copy(config = config) else e },
        updatingKeys = it.updatingKeys + flag.key,
      )
    }
    scope.launch {
      request(
        onError = { error ->
          _state.update {
            it.copy(
              flags = previous,
              statusText = "Update failed",
              errorText = error.message,
              updatingKeys = it.updatingKeys - flag.key,
            )
          }
        },
      ) {
        val updated = client.setFeatureFlag(flag.key, flag.enabled, config)
        _state.update {
          it.copy(
            flags = it.flags.map { e -> if (e.key == flag.key) updated else e },
            statusText = "Updated ${flag.label}",
            updatingKeys = it.updatingKeys - flag.key,
          )
        }
      }
    }
  }

  private fun request(onError: (Exception) -> Unit, action: () -> Unit) {
    try {
      action()
    } catch (error: McpConnectionException) {
      reportFailure(error, onError)
    } catch (error: IOException) {
      reportFailure(error, onError)
    } catch (error: SerializationException) {
      reportFailure(error, onError)
    } catch (error: InterruptedException) {
      reportFailure(error, onError)
    } catch (error: IllegalArgumentException) {
      reportFailure(error, onError)
    }
  }

  private fun reportFailure(error: Exception, onError: (Exception) -> Unit) {
    LoggerFactory.getLogger("FeatureFlagsViewModel").warn("Feature flag request failed", error)
    onError(error)
  }

  fun dispose() {
    scope.cancel()
    client.close()
  }
}

@Composable
internal fun FeatureFlagsSection(clientProvider: () -> AutoMobileClient) {
  val colors = SharedTheme.globalColors
  val viewModel = remember { FeatureFlagsViewModel(clientProvider()) }
  val uiState by viewModel.state.collectAsState()

  DisposableEffect(Unit) { onDispose { viewModel.dispose() } }
  LaunchedEffect(Unit) { viewModel.loadFlags() }

  SectionHeader("Feature Flags")

  Row(
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Text(uiState.statusText, fontSize = 13.sp, color = colors.text.normal.copy(alpha = 0.7f))
    Box(
      modifier =
        Modifier.clickable { viewModel.loadFlags() }
          .pointerHoverIcon(PointerIcon.Hand)
          .background(colors.text.normal.copy(alpha = 0.08f), RoundedCornerShape(4.dp))
          .padding(horizontal = 10.dp, vertical = 6.dp),
    ) {
      Text("Refresh", fontSize = 12.sp)
    }
  }

  if (!uiState.errorText.isNullOrBlank()) {
    val errText = uiState.errorText ?: ""
    Text(errText, fontSize = 12.sp, color = colors.text.error)
  }

  Spacer(Modifier.height(8.dp))

  uiState.flags.forEach { flag ->
    FeatureFlagRow(
      flag = flag,
      isUpdating = uiState.updatingKeys.contains(flag.key),
      onToggle = { enabled -> viewModel.toggleFlag(flag, enabled) },
      onUpdateConfig = { config -> viewModel.updateFlagConfig(flag, config) },
    )
    Spacer(Modifier.height(8.dp))
  }
}

@Composable
private fun FeatureFlagRow(
  flag: FeatureFlagState,
  isUpdating: Boolean,
  onToggle: (Boolean) -> Unit,
  onUpdateConfig: (JsonObject) -> Unit,
) {
  val colors = SharedTheme.globalColors

  Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Checkbox(
        checked = flag.enabled,
        onCheckedChange = { if (!isUpdating) onToggle(it) },
        enabled = !isUpdating,
      )
      Text(flag.label, fontSize = 13.sp, fontWeight = FontWeight.Medium)
    }

    val desc = flag.description
    if (!desc.isNullOrBlank()) {
      Text(
        desc,
        fontSize = 12.sp,
        color = colors.text.normal.copy(alpha = 0.6f),
        modifier = Modifier.padding(start = 28.dp),
      )
    }

    if (flag.key == "accessibility-audit") {
      AccessibilityConfigPanel(
        flag = flag,
        isUpdating = isUpdating,
        onConfigChange = onUpdateConfig,
      )
    }
  }
}

@Composable
private fun AccessibilityConfigPanel(
  flag: FeatureFlagState,
  isUpdating: Boolean,
  onConfigChange: (JsonObject) -> Unit,
) {
  val colors = SharedTheme.globalColors
  val state = remember { AccessibilityConfigState(flag.config) }
  LaunchedEffect(flag.config) { state.load(flag.config) }
  val submit = { onConfigChange(state.toJson()) }

  Column(
    modifier = Modifier.padding(start = 28.dp),
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Text(
      "Accessibility audit settings",
      fontSize = 12.sp,
      color = colors.text.normal.copy(alpha = 0.6f),
    )

    AccessibilityOptions(state, isUpdating, submit)

    Row(verticalAlignment = Alignment.CenterVertically) {
      Checkbox(
        checked = state.useBaseline,
        onCheckedChange = {
          if (!isUpdating) {
            state.useBaseline = it
            submit()
          }
        },
        enabled = !isUpdating,
      )
      Text("Use baseline", fontSize = 12.sp)
    }
  }
}

/** Simple option selector using chip-style buttons (replaces Jewel's ListComboBox). */
@Composable
private fun OptionSelector(
  options: List<String>,
  selected: String,
  isUpdating: Boolean,
  onSelect: (String) -> Unit,
) {
  Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
    options.forEach { option ->
      Box(
        modifier =
          Modifier.clickable(enabled = !isUpdating) { onSelect(option) }
            .pointerHoverIcon(PointerIcon.Hand)
            .background(
              if (option == selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.2f)
              else SharedTheme.globalColors.text.normal.copy(alpha = 0.05f),
              RoundedCornerShape(4.dp),
            )
            .padding(horizontal = 8.dp, vertical = 4.dp),
      ) {
        Text(
          option,
          fontSize = 11.sp,
          color =
            if (option == selected) MaterialTheme.colorScheme.primary
            else SharedTheme.globalColors.text.normal,
        )
      }
    }
  }
}

private fun readConfigValue(config: JsonObject?, key: String, fallback: String): String {
  val value = config?.get(key)
  return (value as? JsonPrimitive)?.content ?: fallback
}

private fun readConfigBoolean(config: JsonObject?, key: String, fallback: Boolean): Boolean {
  val value = config?.get(key)
  return (value as? JsonPrimitive)?.content?.toBooleanStrictOrNull() ?: fallback
}

private class AccessibilityConfigState(config: JsonObject?) {
  var level by mutableStateOf(readConfigValue(config, "level", "AA"))
  var failureMode by mutableStateOf(readConfigValue(config, "failureMode", "report"))
  var minSeverity by mutableStateOf(readConfigValue(config, "minSeverity", "warning"))
  var useBaseline by mutableStateOf(readConfigBoolean(config, "useBaseline", false))

  fun load(config: JsonObject?) {
    level = readConfigValue(config, "level", "AA")
    failureMode = readConfigValue(config, "failureMode", "report")
    minSeverity = readConfigValue(config, "minSeverity", "warning")
    useBaseline = readConfigBoolean(config, "useBaseline", false)
  }

  fun toJson(): JsonObject = buildJsonObject {
    put("level", JsonPrimitive(level))
    put("failureMode", JsonPrimitive(failureMode))
    put("minSeverity", JsonPrimitive(minSeverity))
    put("useBaseline", JsonPrimitive(useBaseline))
  }
}

@Composable
private fun AccessibilityOptions(
  state: AccessibilityConfigState,
  isUpdating: Boolean,
  submit: () -> Unit,
) {
  Row(
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    Text("Level", fontSize = 12.sp)
    OptionSelector(ACCESSIBILITY_LEVELS, state.level, isUpdating) {
      state.level = it
      submit()
    }
    Text("Failure", fontSize = 12.sp)
    OptionSelector(ACCESSIBILITY_FAILURE_MODES, state.failureMode, isUpdating) {
      state.failureMode = it
      submit()
    }
    Text("Min severity", fontSize = 12.sp)
    OptionSelector(ACCESSIBILITY_SEVERITIES, state.minSeverity, isUpdating) {
      state.minSeverity = it
      submit()
    }
  }
}
