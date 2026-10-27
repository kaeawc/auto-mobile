package dev.jasonpearson.automobile.demos

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.design.system.components.AutoMobileContentButton
import dev.jasonpearson.automobile.design.system.components.AutoMobileContentCard
import dev.jasonpearson.automobile.design.system.components.AutoMobileTopAppBar
import dev.jasonpearson.automobile.sdk.TrackRecomposition
import dev.jasonpearson.automobile.sdk.failures.AutoMobileFailures

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HandledExceptionDemoScreen(onNavigateBack: () -> Unit) {
  TrackRecomposition(
    id = "screen.demo.handled.exception",
    composableName = "HandledExceptionDemoScreen",
  ) {
    val state = remember { HandledExceptionState() }

    Scaffold(
      topBar = {
        AutoMobileTopAppBar(
          title = { Text(text = "Handled Exceptions Demo") },
          navigationIcon = {
            IconButton(
              onClick = onNavigateBack,
              modifier = Modifier.semantics { testTag = "handled_exception_back" },
            ) {
              Icon(
                imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                contentDescription = "Back",
              )
            }
          },
        )
      },
    ) { paddingValues ->
      HandledExceptionContent(paddingValues, state)
    }
  }
}

@Composable
private fun NullPointerExceptionButton(state: HandledExceptionState) {
  // NullPointerException
  AutoMobileContentButton(
    onClick = {
      try {
        val nullString: String? = null
        @Suppress("UNUSED_VARIABLE") val length = nullString!!.length
      } catch (e: NullPointerException) {
        AutoMobileFailures.recordHandledException(
          e,
          "Intentional NPE from demo screen",
          "HandledExceptionDemoScreen",
        )
        state.exceptionCount++
        state.lastExceptionType = "NullPointerException"
        state.statusMessage = "Recorded NullPointerException"
      }
    },
    modifier = Modifier.fillMaxWidth().semantics { testTag = "trigger_null_pointer_exception" },
  ) {
    Text("Trigger NullPointerException")
  }
}

@Composable
private fun IllegalArgumentExceptionButton(state: HandledExceptionState) {
  // IllegalArgumentException
  AutoMobileContentButton(
    onClick = {
      try {
        require(false) { "This is an intentional IllegalArgumentException" }
      } catch (e: IllegalArgumentException) {
        AutoMobileFailures.recordHandledException(
          e,
          "Intentional IAE from demo screen",
          "HandledExceptionDemoScreen",
        )
        state.exceptionCount++
        state.lastExceptionType = "IllegalArgumentException"
        state.statusMessage = "Recorded IllegalArgumentException"
      }
    },
    modifier =
      Modifier.fillMaxWidth().semantics {
        testTag = "trigger_illegal_argument_exception"
      },
  ) {
    Text("Trigger IllegalArgumentException")
  }
}

@Composable
private fun IllegalStateExceptionButton(state: HandledExceptionState) {
  // IllegalStateException
  AutoMobileContentButton(
    onClick = {
      try {
        check(false) { "This is an intentional IllegalStateException" }
      } catch (e: IllegalStateException) {
        AutoMobileFailures.recordHandledException(
          e,
          "Intentional ISE from demo screen",
          "HandledExceptionDemoScreen",
        )
        state.exceptionCount++
        state.lastExceptionType = "IllegalStateException"
        state.statusMessage = "Recorded IllegalStateException"
      }
    },
    modifier = Modifier.fillMaxWidth().semantics { testTag = "trigger_illegal_state_exception" },
  ) {
    Text("Trigger IllegalStateException")
  }
}

@Composable
private fun IndexOutOfBoundsExceptionButton(state: HandledExceptionState) {
  // IndexOutOfBoundsException
  AutoMobileContentButton(
    onClick = {
      try {
        val list = listOf(1, 2, 3)
        @Suppress("UNUSED_VARIABLE") val item = list[10]
      } catch (e: IndexOutOfBoundsException) {
        AutoMobileFailures.recordHandledException(
          e,
          "Intentional IOOBE from demo screen",
          "HandledExceptionDemoScreen",
        )
        state.exceptionCount++
        state.lastExceptionType = "IndexOutOfBoundsException"
        state.statusMessage = "Recorded IndexOutOfBoundsException"
      }
    },
    modifier =
      Modifier.fillMaxWidth().semantics {
        testTag = "trigger_index_out_of_bounds_exception"
      },
  ) {
    Text("Trigger IndexOutOfBoundsException")
  }
}

@Composable
private fun NumberFormatExceptionButton(state: HandledExceptionState) {
  // NumberFormatException
  AutoMobileContentButton(
    onClick = {
      try {
        @Suppress("UNUSED_VARIABLE") val number = "not_a_number".toInt()
      } catch (e: NumberFormatException) {
        AutoMobileFailures.recordHandledException(
          e,
          "Intentional NFE from demo screen",
          "HandledExceptionDemoScreen",
        )
        state.exceptionCount++
        state.lastExceptionType = "NumberFormatException"
        state.statusMessage = "Recorded NumberFormatException"
      }
    },
    modifier = Modifier.fillMaxWidth().semantics { testTag = "trigger_number_format_exception" },
  ) {
    Text("Trigger NumberFormatException")
  }
}

@Composable
private fun RuntimeExceptionButton(state: HandledExceptionState) {
  // Custom exception without message
  AutoMobileContentButton(
    onClick = {
      try {
        throw RuntimeException("Custom runtime exception for testing")
      } catch (e: RuntimeException) {
        AutoMobileFailures.recordHandledException(e)
        state.exceptionCount++
        state.lastExceptionType = "RuntimeException"
        state.statusMessage = "Recorded RuntimeException (no custom message)"
      }
    },
    modifier = Modifier.fillMaxWidth().semantics { testTag = "trigger_runtime_exception" },
  ) {
    Text("Trigger RuntimeException (no message)")
  }
}

@Composable
private fun HandledExceptionStatus(state: HandledExceptionState) {
  AutoMobileContentCard(
    modifier = Modifier.fillMaxWidth().semantics { testTag = "handled_exception_status_card" },
    elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
  ) {
    Column(
      modifier = Modifier.fillMaxWidth().padding(16.dp),
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Text(
        text = "Exceptions recorded: ${state.exceptionCount}",
        style = MaterialTheme.typography.titleMedium,
        modifier = Modifier.semantics { testTag = "handled_exception_count" },
      )
      Text(
        text = "Last type: ${state.lastExceptionType ?: "None"}",
        style = MaterialTheme.typography.bodyMedium,
        modifier = Modifier.semantics { testTag = "handled_exception_last_type" },
      )
      Text(
        text = state.statusMessage,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.semantics { testTag = "handled_exception_status" },
      )
    }
  }
}

@Composable
private fun HandledExceptionContent(
  paddingValues: androidx.compose.foundation.layout.PaddingValues,
  state: HandledExceptionState,
) {
  Column(
    modifier =
      Modifier.fillMaxSize()
        .padding(paddingValues)
        .padding(16.dp)
        .verticalScroll(rememberScrollState())
        .semantics { testTag = "handled_exception_content" },
    verticalArrangement = Arrangement.spacedBy(16.dp),
  ) {
    Text(
      text =
        "Test the handled exceptions API by triggering different exception types. " +
          "These exceptions are caught and reported to the MCP server.",
      style = MaterialTheme.typography.bodyLarge,
    )

    HandledExceptionStatus(state)

    Text(
      text = "Trigger Exception Types",
      style = MaterialTheme.typography.titleMedium,
    )

    NullPointerExceptionButton(state)

    IllegalArgumentExceptionButton(state)

    IllegalStateExceptionButton(state)

    IndexOutOfBoundsExceptionButton(state)

    NumberFormatExceptionButton(state)

    RuntimeExceptionButton(state)

    // Reset counter
    AutoMobileContentButton(
      onClick = {
        state.exceptionCount = 0
        state.lastExceptionType = null
        state.statusMessage = "Counter reset"
      },
      colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.secondary),
      modifier = Modifier.fillMaxWidth().semantics { testTag = "reset_exception_counter" },
    ) {
      Text("Reset Counter")
    }
  }
}

private class HandledExceptionState {
  var exceptionCount by mutableIntStateOf(0)
  var lastExceptionType by mutableStateOf<String?>(null)
  var statusMessage by mutableStateOf("No exceptions recorded yet")
}
