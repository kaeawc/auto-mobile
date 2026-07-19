package dev.jasonpearson.automobile.desktop.core.theme

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Accessible
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Explore
import androidx.compose.material.icons.filled.HourglassEmpty
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material.icons.filled.LocalHospital
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material.icons.filled.Public
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.ReportProblem
import androidx.compose.material.icons.filled.Satellite
import androidx.compose.material.icons.filled.SaveAlt
import androidx.compose.material.icons.filled.Science
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.Warning
import androidx.compose.ui.graphics.vector.ImageVector

/**
 * Centralized vector icon definitions for the AutoMobile desktop app. Uses Material Icons Extended
 * where available.
 */
object AppIcons {
  // -- Telemetry categories --
  val Network: ImageVector
    get() = Icons.Filled.Public

  val Navigation: ImageVector
    get() = Icons.Filled.Explore

  val Logs: ImageVector
    get() = Icons.Filled.Description

  val Os: ImageVector
    get() = Icons.Filled.Settings

  val Failures: ImageVector
    get() = Icons.Filled.ReportProblem

  val StorageCategory: ImageVector
    get() = Icons.Filled.Storage

  val Layout: ImageVector
    get() = Icons.Filled.Layers

  val Performance: ImageVector
    get() = Icons.Filled.BarChart

  val ToolCalls: ImageVector
    get() = Icons.Filled.Build

  val Accessibility: ImageVector
    get() = Icons.AutoMirrored.Filled.Accessible

  val Memory: ImageVector
    get() = Icons.Filled.Psychology

  val All: ImageVector
    get() = Icons.Filled.Tune

  // -- Toolbar actions --
  val Delete: ImageVector
    get() = Icons.Filled.Delete

  val Pause: ImageVector
    get() = Icons.Filled.Pause

  val Play: ImageVector
    get() = Icons.Filled.PlayArrow

  val Refresh: ImageVector
    get() = Icons.Filled.Refresh

  val ScrollDown: ImageVector
    get() = Icons.Filled.KeyboardArrowDown

  // -- Status indicators --
  val StatusDot: ImageVector
    get() = Icons.Filled.Circle

  // -- Severity --
  val SeverityError: ImageVector
    get() = Icons.Filled.Error

  val SeverityWarning: ImageVector
    get() = Icons.Filled.Warning

  val SeverityInfo: ImageVector
    get() = Icons.Filled.Info

  // -- Failure subtypes --
  val Crash: ImageVector
    get() = Icons.Filled.ReportProblem

  val Anr: ImageVector
    get() = Icons.Filled.HourglassEmpty

  val NonFatal: ImageVector
    get() = Icons.Filled.Warning

  // -- Horizontal tab icons --
  val TestRuns: ImageVector
    get() = Icons.Filled.Science

  val Storage: ImageVector
    get() = Icons.Filled.SaveAlt

  val Diagnostics: ImageVector
    get() = Icons.Filled.LocalHospital

  val Snapshots: ImageVector
    get() = Icons.Filled.PhotoCamera

  val DeviceControls: ImageVector
    get() = Icons.Filled.Tune

  val Telemetry: ImageVector
    get() = Icons.Filled.Satellite
}
