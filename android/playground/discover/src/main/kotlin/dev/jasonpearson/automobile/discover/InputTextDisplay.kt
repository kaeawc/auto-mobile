package dev.jasonpearson.automobile.discover

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.ClickableText
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.design.system.components.AutoMobileContentCard

@Composable
internal fun RichTextDisplay() {
  AutoMobileContentCard(
    modifier = Modifier.fillMaxWidth(),
    elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
  ) {
    Column(modifier = Modifier.padding(16.dp)) {
      Text(
        text = "Rich Text Display",
        fontSize = 18.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier.padding(bottom = 8.dp),
      )

      Text(
        text =
          buildAnnotatedString {
            append("This text contains ")
            withStyle(style = SpanStyle(fontWeight = FontWeight.Bold)) { append("bold") }
            append(", ")
            withStyle(style = SpanStyle(fontStyle = FontStyle.Italic)) {
              append("italic")
            }
            append(", and ")
            withStyle(style = SpanStyle(color = Color.Blue)) { append("colored") }
            append(" text.")
          },
        modifier = Modifier.fillMaxWidth(),
      )
    }
  }
}

@Composable
internal fun ClickableUrlText() {
  AutoMobileContentCard(
    modifier = Modifier.fillMaxWidth(),
    elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
  ) {
    Column(modifier = Modifier.padding(16.dp)) {
      Text(
        text = "Clickable URL Text",
        fontSize = 18.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier.padding(bottom = 8.dp),
      )

      val uriHandler = LocalUriHandler.current
      val annotatedText = buildAnnotatedString {
        append("Visit our website at ")
        pushStringAnnotation(tag = "URL", annotation = "https://www.example.com")
        withStyle(
          style = SpanStyle(color = Color.Blue, textDecoration = TextDecoration.Underline),
        ) {
          append("example.com")
        }
        pop()
        append(" for more information.")
      }

      ClickableText(
        text = annotatedText,
        onClick = { offset ->
          annotatedText
            .getStringAnnotations(tag = "URL", start = offset, end = offset)
            .firstOrNull()
            ?.let { annotation -> uriHandler.openUri(annotation.item) }
        },
      )
    }
  }
}

@Composable
internal fun SelectableTextDisplay() {
  AutoMobileContentCard(
    modifier = Modifier.fillMaxWidth(),
    elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
  ) {
    Column(modifier = Modifier.padding(16.dp)) {
      Text(
        text = "Selectable Text",
        fontSize = 18.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier.padding(bottom = 8.dp),
      )

      SelectionContainer {
        Text(
          text =
            "This text can be selected and copied. Long press to start text selection and drag to select the desired text portion.",
          modifier = Modifier.fillMaxWidth(),
        )
      }
    }
  }
}
