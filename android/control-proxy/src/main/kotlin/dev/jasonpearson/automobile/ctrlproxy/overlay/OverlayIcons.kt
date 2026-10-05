package dev.jasonpearson.automobile.ctrlproxy.overlay

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.ui.graphics.vector.ImageVector

/** Closed contract names; unknown names keep the neutral semantic placeholder. */
fun overlayIcon(name: String?): ImageVector? =
  when (name) {
    "home" -> Icons.Default.Home
    "search" -> Icons.Default.Search
    "settings" -> Icons.Default.Settings
    "person" -> Icons.Default.Person
    "favorite" -> Icons.Default.Favorite
    "add" -> Icons.Default.Add
    "close" -> Icons.Default.Close
    "check" -> Icons.Default.Check
    "arrow_back" -> Icons.Default.ArrowBack
    "arrow_forward" -> Icons.Default.ArrowForward
    "chevron_left" -> Icons.Default.ChevronLeft
    "chevron_right" -> Icons.Default.ChevronRight
    "menu" -> Icons.Default.Menu
    "more_vert" -> Icons.Default.MoreVert
    "share" -> Icons.Default.Share
    "edit" -> Icons.Default.Edit
    "delete" -> Icons.Default.Delete
    "info" -> Icons.Default.Info
    "warning" -> Icons.Default.Warning
    "notifications" -> Icons.Default.Notifications
    "star" -> Icons.Default.Star
    "shopping_cart" -> Icons.Default.ShoppingCart
    "help" -> Icons.Default.Help
    "refresh" -> Icons.Default.Refresh
    "done" -> Icons.Default.Done
    "cancel" -> Icons.Default.Cancel
    "play_arrow" -> Icons.Default.PlayArrow
    "pause" -> Icons.Default.Pause
    "stop" -> Icons.Default.Stop
    "mail" -> Icons.Default.Mail
    "phone" -> Icons.Default.Phone
    "location_on" -> Icons.Default.LocationOn
    "calendar_today" -> Icons.Default.CalendarToday
    "visibility" -> Icons.Default.Visibility
    "lock" -> Icons.Default.Lock
    "logout" -> Icons.Default.Logout
    else -> null
  }
