package dev.jasonpearson.automobile.desktop.core.navigation

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

/** The navigate action for one transition and the last attempt along it (#16953). */
data class TransitionNavigateAction(
  val availability: EdgeNavigateAvailability,
  val outcome: EdgeNavigationOutcome?,
  val onNavigate: () -> Unit,
)

/**
 * The transition detail's navigate action. A speculative attempt carries a warning before it runs,
 * and every attempt reports whether it reached the target afterwards, visibly and in accessible
 * text. Disabled (offline / read-only) shows the action greyed out with no click.
 */
@Composable
internal fun TransitionNavigateActionView(
  transition: ScreenTransition,
  action: TransitionNavigateAction,
  verificationNow: EdgeVerification,
  modifier: Modifier = Modifier,
) {
  val colors = SharedTheme.globalColors
  val availability = action.availability
  val running = action.outcome is EdgeNavigationOutcome.Running
  val enabled = availability != EdgeNavigateAvailability.Disabled && !running
  Column(modifier) {
    Text(
      EdgeNavigation.actionLabel(availability),
      fontSize = 12.sp,
      color = if (enabled) colors.text.normal else colors.text.normal.copy(alpha = 0.4f),
      modifier =
        Modifier.background(colors.text.normal.copy(alpha = 0.08f), RoundedCornerShape(4.dp))
          .let { if (enabled) it.clickable(onClick = action.onNavigate) else it }
          .padding(horizontal = 8.dp, vertical = 4.dp)
          .semantics {
            contentDescription = EdgeNavigation.actionDescription(transition, availability)
          },
    )
    if (availability == EdgeNavigateAvailability.Speculative) {
      Text(
        EdgeNavigation.SPECULATIVE_WARNING,
        fontSize = 11.sp,
        color = colors.text.normal.copy(alpha = 0.6f),
        modifier = Modifier.padding(top = 4.dp),
      )
    }
    action.outcome
      ?.takeIf { it.transition.id == transition.id }
      ?.let { outcome ->
        val text = EdgeNavigation.outcomeText(outcome, verificationNow)
        Text(
          text,
          fontSize = 11.sp,
          color = colors.text.normal.copy(alpha = 0.8f),
          modifier = Modifier.padding(top = 4.dp).semantics { contentDescription = text },
        )
      }
  }
}
