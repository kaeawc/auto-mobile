package dev.jasonpearson.automobile.demos

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.design.system.components.AutoMobileContentButton
import dev.jasonpearson.automobile.design.system.components.AutoMobileContentCard
import dev.jasonpearson.automobile.design.system.components.AutoMobileTopAppBar
import dev.jasonpearson.automobile.sdk.TrackRecomposition

private data class DemoEntry(
  val id: String,
  val title: String,
  val description: String,
  val buttonLabel: String,
  val onClick: () -> Unit,
)

data class DemoIndexNavigation(
  val onNavigateToUxFlow: () -> Unit,
  val onNavigateToStartup: () -> Unit,
  val onNavigateToPerformanceList: () -> Unit,
  val onNavigateToContrast: () -> Unit,
  val onNavigateToTapTargets: () -> Unit,
  val onNavigateToXmlSemanticLinks: () -> Unit,
  val onNavigateToComposeSemanticLinks: () -> Unit,
  val onNavigateToNestedSelection: () -> Unit,
  val onNavigateToBugRepro: () -> Unit,
  val onNavigateToHandledException: () -> Unit = {},
  val onNavigateToNetworkTest: () -> Unit = {},
  val onNavigateToDesignSystem: () -> Unit = {},
  val onNavigateToPointerProbe: () -> Unit = {},
  val onNavigateBack: () -> Unit = {},
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DemoIndexScreen(navigation: DemoIndexNavigation) {
  TrackRecomposition(id = "screen.demo.index", composableName = "DemoIndexScreen") {
    val demos =
      primaryDemos(
        navigation.onNavigateToUxFlow,
        navigation.onNavigateToStartup,
        navigation.onNavigateToPerformanceList,
      ) +
        accessibilityDemos(
          navigation.onNavigateToContrast,
          navigation.onNavigateToTapTargets,
          navigation.onNavigateToXmlSemanticLinks,
          navigation.onNavigateToComposeSemanticLinks,
        ) +
        diagnosticDemos(
          navigation.onNavigateToNestedSelection,
          navigation.onNavigateToBugRepro,
          navigation.onNavigateToHandledException,
          navigation.onNavigateToNetworkTest,
        ) +
        toolingDemos(
          navigation.onNavigateToDesignSystem,
          navigation.onNavigateToPointerProbe,
        )

    Scaffold(
      topBar = {
        AutoMobileTopAppBar(
          title = { Text(text = "Docs Demo Index") },
          navigationIcon = {
            IconButton(
              onClick = navigation.onNavigateBack,
              modifier = Modifier.semantics { testTag = "demo_index_back" },
            ) {
              Icon(
                imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                contentDescription = "Back",
              )
            }
          },
          colors = TopAppBarDefaults.topAppBarColors(),
        )
      },
    ) { paddingValues ->
      DemoIndexContent(paddingValues, demos)
    }
  }
}

@Composable
private fun DemoIndexCard(demo: DemoEntry) {
  AutoMobileContentCard(
    modifier = Modifier.fillMaxWidth().semantics { testTag = demo.id },
    elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
  ) {
    Column(
      modifier = Modifier.fillMaxWidth().padding(16.dp),
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Text(text = demo.title, style = MaterialTheme.typography.titleMedium)
      Text(text = demo.description, style = MaterialTheme.typography.bodySmall)
      AutoMobileContentButton(
        onClick = demo.onClick,
        modifier = Modifier.align(Alignment.End).semantics { testTag = "${demo.id}_action" },
      ) {
        Text(demo.buttonLabel)
      }
    }
  }
}

@Composable
private fun DemoIndexContent(paddingValues: PaddingValues, demos: List<DemoEntry>) {
  Column(
    modifier =
      Modifier.fillMaxSize().padding(paddingValues).padding(horizontal = 16.dp, vertical = 12.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Text(
      text = "Use these screens for AutoMobile docs workflows.",
      style = MaterialTheme.typography.bodyMedium,
      modifier = Modifier.semantics { testTag = "demo_index_description" },
    )

    LazyColumn(
      modifier = Modifier.fillMaxSize().semantics { testTag = "demo_index_list" },
      contentPadding = PaddingValues(bottom = 16.dp),
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      items(demos, key = { it.id }) { demo ->
        DemoIndexCard(demo)
      }
    }
  }
}

private fun primaryDemos(
  onNavigateToUxFlow: () -> Unit,
  onNavigateToStartup: () -> Unit,
  onNavigateToPerformanceList: () -> Unit,
): List<DemoEntry> =
  listOf(
    DemoEntry(
      id = "demo_ux_flow",
      title = "UX Exploration Flow",
      description = "Multi-screen path for navigation graph exploration.",
      buttonLabel = "Open UX Flow",
      onClick = onNavigateToUxFlow,
    ),
    DemoEntry(
      id = "demo_startup",
      title = "Startup Performance",
      description = "Stable screen used as startup target.",
      buttonLabel = "Open Startup",
      onClick = onNavigateToStartup,
    ),
    DemoEntry(
      id = "demo_perf_list",
      title = "Scroll + Transition Performance",
      description = "Long list with detail navigation for metrics.",
      buttonLabel = "Open List",
      onClick = onNavigateToPerformanceList,
    ),
  )

private fun accessibilityDemos(
  onNavigateToContrast: () -> Unit,
  onNavigateToTapTargets: () -> Unit,
  onNavigateToXmlSemanticLinks: () -> Unit,
  onNavigateToComposeSemanticLinks: () -> Unit,
): List<DemoEntry> =
  listOf(
    DemoEntry(
      id = "demo_a11y_contrast",
      title = "Accessibility: Contrast",
      description = "Intentional low-contrast UI examples.",
      buttonLabel = "Open Contrast",
      onClick = onNavigateToContrast,
    ),
    DemoEntry(
      id = "demo_a11y_tap_targets",
      title = "Accessibility: Tap Targets",
      description = "Small target sizes and tight spacing.",
      buttonLabel = "Open Tap Targets",
      onClick = onNavigateToTapTargets,
    ),
    DemoEntry(
      id = "demo_a11y_links_xml",
      title = "Accessibility: Semantic Links (View/XML)",
      description = "ClickableSpan links, including duplicate inline link text.",
      buttonLabel = "Open View/XML Links",
      onClick = onNavigateToXmlSemanticLinks,
    ),
    DemoEntry(
      id = "demo_a11y_links_compose",
      title = "Accessibility: Semantic Links (Compose)",
      description = "LinkAnnotation links, including duplicate inline link text.",
      buttonLabel = "Open Compose Links",
      onClick = onNavigateToComposeSemanticLinks,
    ),
  )

private fun diagnosticDemos(
  onNavigateToNestedSelection: () -> Unit,
  onNavigateToBugRepro: () -> Unit,
  onNavigateToHandledException: () -> Unit,
  onNavigateToNetworkTest: () -> Unit,
): List<DemoEntry> =
  listOf(
    DemoEntry(
      id = "demo_nested_selection",
      title = "Nested Selection",
      description = "Two carts with duplicate item ids, quantity fields and remove buttons.",
      buttonLabel = "Open Nested Selection",
      onClick = onNavigateToNestedSelection,
    ),
    DemoEntry(
      id = "demo_bug_repro",
      title = "Bug Reproduction",
      description = "Toggleable bug to reproduce reliably.",
      buttonLabel = "Open Bug Demo",
      onClick = onNavigateToBugRepro,
    ),
    DemoEntry(
      id = "demo_handled_exception",
      title = "Handled Exceptions",
      description = "Test handled exception reporting API.",
      buttonLabel = "Open Exception Demo",
      onClick = onNavigateToHandledException,
    ),
    DemoEntry(
      id = "demo_network_test",
      title = "Network Test",
      description = "HTTP requests, failures, and random user images.",
      buttonLabel = "Open Network Test",
      onClick = onNavigateToNetworkTest,
    ),
  )

private fun toolingDemos(
  onNavigateToDesignSystem: () -> Unit,
  onNavigateToPointerProbe: () -> Unit,
): List<DemoEntry> =
  listOf(
    DemoEntry(
      id = "demo_design_system",
      title = "Design System",
      description = "Hand-drawn crayon components: buttons, cards, nav, dialogs.",
      buttonLabel = "Open Design System",
      onClick = onNavigateToDesignSystem,
    ),
    DemoEntry(
      id = "demo_pointer_probe",
      title = "Pointer Probe",
      description = "Logs tool type, source, pressure, tilt and buttons of every MotionEvent.",
      buttonLabel = "Open Pointer Probe",
      onClick = onNavigateToPointerProbe,
    ),
  )
