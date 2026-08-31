package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/** One capability shown on the onboarding coach panel: an emoji + a plain-language line. */
private data class Capability(val icon: String, val text: String)

// Only capabilities that are actually wired today — no live streams, navigation, or
// emulator-control
// execution yet, so the panel doesn't promise inert functionality.
private val CAPABILITIES =
  listOf(
    Capability("🖥", "Observe devices — pick booted devices and open them as side-by-side panes"),
    // Storage tooling is Android-only (#4708), so qualify it rather than naming storage as a
    // universal capability the iOS panes don't have yet (#4721).
    Capability("🧭", "Inspect per device — dock the logs, and storage on Android, into each pane"),
    Capability("⧉", "Compare devices — open the same tool across devices for a like-for-like view"),
  )

/**
 * First-run onboarding: a plain "what you can do here" coach panel. Deliberately free of any
 * AI/assistant framing — it describes the concrete device-workspace capabilities and nothing more.
 */
@Composable
fun OnboardingScreen(onGetStarted: () -> Unit, modifier: Modifier = Modifier) {
  Column(
    modifier =
      modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(32.dp),
    verticalArrangement = Arrangement.Center,
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Column(Modifier.widthIn(max = 560.dp)) {
      Text(
        "Welcome to AutoMobile",
        style = MaterialTheme.typography.headlineMedium,
        fontWeight = FontWeight.SemiBold,
      )
      Spacer(Modifier.height(6.dp))
      Text(
        "Drive and inspect real devices from your desktop.",
        style = MaterialTheme.typography.bodyLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
      Spacer(Modifier.height(24.dp))
      Text(
        "WHAT YOU CAN DO HERE",
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
      Spacer(Modifier.height(10.dp))
      CAPABILITIES.forEach { capability ->
        Row(Modifier.padding(vertical = 6.dp), verticalAlignment = Alignment.Top) {
          Text(capability.icon)
          Spacer(Modifier.width(12.dp))
          Text(capability.text, style = MaterialTheme.typography.bodyMedium)
        }
      }
      Spacer(Modifier.height(28.dp))
      // Material3 Button: themed container/content colors carry sufficient contrast (vs a
      // hand-rolled
      // white-on-accent treatment) and bring button semantics for free.
      Button(
        onClick = onGetStarted,
        modifier = Modifier.semantics { contentDescription = "Get started" },
      ) {
        Text("Get started")
      }
    }
  }
}
