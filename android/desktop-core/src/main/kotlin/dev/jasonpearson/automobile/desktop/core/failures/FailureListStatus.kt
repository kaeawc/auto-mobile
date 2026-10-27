package dev.jasonpearson.automobile.desktop.core.failures

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

@Composable
internal fun FailureListOptions.FakeFailureBanner() {
  val colors = SharedTheme.globalColors
  if (dataSourceMode == DataSourceMode.Fake && fakeDataSource != null) {
    Row(
      modifier =
        Modifier.fillMaxWidth()
          .background(Color(0xFF4CAF50).copy(alpha = 0.1f), RoundedCornerShape(8.dp))
          .padding(12.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.SpaceBetween,
    ) {
      Column {
        Text(
          "Fake Mode",
          fontSize = 12.sp,
          fontWeight = FontWeight.Medium,
          color = Color(0xFF4CAF50),
        )
        Text(
          "Trigger test failures to see real-time notifications",
          fontSize = 10.sp,
          color = colors.text.normal.copy(alpha = 0.6f),
        )
      }
      Box(
        modifier =
          Modifier.background(Color(0xFF4CAF50), RoundedCornerShape(6.dp))
            .clickable(onClick = onTriggerFakeFailure)
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(horizontal = 12.dp, vertical = 8.dp),
      ) {
        Text(
          "Trigger Failure",
          fontSize = 11.sp,
          fontWeight = FontWeight.Medium,
          color = Color.White,
        )
      }
    }
    Spacer(Modifier.height(16.dp))
  }
}

@Composable
internal fun FailureListOptions.FailureStreamingWarning() {
  val colors = SharedTheme.globalColors
  if (streamingError != null && errorMessage == null) {
    Box(
      modifier =
        Modifier.fillMaxWidth()
          .background(Color(0xFFFF9800).copy(alpha = 0.1f), RoundedCornerShape(8.dp))
          .padding(12.dp),
    ) {
      Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
        modifier = Modifier.fillMaxWidth(),
      ) {
        Column(modifier = Modifier.weight(1f)) {
          Text(
            "Streaming updates unavailable",
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            color = Color(0xFFFF9800),
          )
          Text(
            streamingError,
            fontSize = 10.sp,
            color = colors.text.normal.copy(alpha = 0.6f),
          )
        }
        Text(
          "Reconnecting...",
          fontSize = 11.sp,
          color = Color(0xFFFF9800).copy(alpha = 0.7f),
          modifier = Modifier.padding(8.dp),
        )
      }
    }
    Spacer(Modifier.height(16.dp))
  }
}

@Composable
internal fun FailureListOptions.FailureLoadError() {
  val colors = SharedTheme.globalColors
  if (errorMessage != null) {
    Box(
      modifier =
        Modifier.fillMaxWidth()
          .background(Color(0xFFE53935).copy(alpha = 0.1f), RoundedCornerShape(8.dp))
          .padding(12.dp),
    ) {
      Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
        modifier = Modifier.fillMaxWidth(),
      ) {
        Column(modifier = Modifier.weight(1f)) {
          Text(
            "Failed to load data",
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            color = Color(0xFFE53935),
          )
          Text(
            errorMessage,
            fontSize = 10.sp,
            color = colors.text.normal.copy(alpha = 0.6f),
          )
        }
        Text(
          "Retry",
          fontSize = 11.sp,
          color = Color(0xFF2196F3),
          modifier =
            Modifier.clickable(onClick = onRetry).pointerHoverIcon(PointerIcon.Hand).padding(8.dp),
        )
      }
    }
    Spacer(Modifier.height(16.dp))
  }
}

@Composable
internal fun FailureListOptions.FailureIssues(
  filteredFailures: List<FailureGroup>,
  onFailureSelected: (FailureGroup) -> Unit,
) {
  val colors = SharedTheme.globalColors
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    if (filteredFailures.isEmpty()) {
      Box(
        modifier = Modifier.fillMaxWidth().padding(32.dp),
        contentAlignment = Alignment.Center,
      ) {
        if (dataSourceMode == DataSourceMode.Real && !isLoading) {
          Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
          ) {
            Text(
              "No failures detected",
              fontSize = 13.sp,
              fontWeight = FontWeight.Medium,
              color = colors.text.normal.copy(alpha = 0.7f),
            )
            Text(
              "AutoMobile tracks crashes and ANRs via logcat and tool failures directly.",
              fontSize = 11.sp,
              color = colors.text.normal.copy(alpha = 0.5f),
            )
            Text(
              "The SDK provides richer context and metadata but is not required.",
              fontSize = 11.sp,
              color = colors.text.normal.copy(alpha = 0.5f),
            )
          }
        } else {
          Text(
            "No failures found",
            color = colors.text.normal.copy(alpha = 0.5f),
          )
        }
      }
    } else {
      filteredFailures.forEach { failure ->
        FailureListItem(
          failure = failure,
          onClick = { onFailureSelected(failure) },
        )
      }
    }
  }
}

@Composable
internal fun FailureListItem(
  failure: FailureGroup,
  onClick: () -> Unit,
) {
  val colors = SharedTheme.globalColors

  Row(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(6.dp))
        .clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(12.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    // Type icon and severity indicator
    Box(
      modifier =
        Modifier.size(36.dp)
          .background(failure.type.color.copy(alpha = 0.15f), RoundedCornerShape(6.dp)),
      contentAlignment = Alignment.Center,
    ) {
      Text(failure.type.icon, fontSize = 16.sp)
    }

    Spacer(Modifier.width(12.dp))

    // Failure info
    Column(modifier = Modifier.weight(1f)) {
      Text(
        failure.title,
        fontSize = 13.sp,
        fontWeight = FontWeight.Medium,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
      Text(
        failure.signature,
        fontSize = 11.sp,
        color = colors.text.normal.copy(alpha = 0.5f),
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    }

    Spacer(Modifier.width(12.dp))

    // Count and severity
    Column(horizontalAlignment = Alignment.End) {
      Text(
        "${failure.totalCount}x",
        fontSize = 12.sp,
        fontWeight = FontWeight.Medium,
        color = failure.severity.color,
      )
      Text(
        failure.severity.label,
        fontSize = 10.sp,
        color = failure.severity.color.copy(alpha = 0.7f),
      )
    }
  }
}
