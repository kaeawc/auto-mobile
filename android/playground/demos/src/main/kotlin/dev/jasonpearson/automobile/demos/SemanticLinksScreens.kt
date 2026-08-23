package dev.jasonpearson.automobile.demos

import android.content.res.Configuration
import android.text.SpannableString
import android.text.method.LinkMovementMethod
import android.text.style.ClickableSpan
import android.view.LayoutInflater
import android.view.View
import android.widget.TextView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.LinkInteractionListener
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import dev.jasonpearson.automobile.sdk.TrackRecomposition

private const val TermsOfService = "Terms of Service"
private const val PrivacyPolicy = "Privacy Policy"
private const val XmlInlineLinksText =
  "Read our Terms of Service before continuing, then review the Terms of Service for updates."

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun XmlSemanticLinksDemoScreen(onNavigateBack: () -> Unit) {
  TrackRecomposition(
    id = "screen.demo.a11y.links.xml",
    composableName = "XmlSemanticLinksDemoScreen",
  ) {
    Scaffold(
      topBar = {
        TopAppBar(
          title = { Text(text = "Semantic Links: View/XML") },
          navigationIcon = {
            IconButton(
              onClick = onNavigateBack,
              modifier = Modifier.semantics { testTag = "semantic_links_xml_back" },
            ) {
              Icon(
                imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                contentDescription = "Back",
              )
            }
          },
        )
      }
    ) { paddingValues ->
      AndroidView(
        modifier =
          Modifier.fillMaxSize()
            .padding(paddingValues),
        factory = { context ->
          LayoutInflater.from(context)
            .inflate(R.layout.screen_semantic_links_xml, null, false)
            .apply { bindXmlSemanticLinks() }
        },
      )
    }
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ComposeSemanticLinksDemoScreen(onNavigateBack: () -> Unit) {
  TrackRecomposition(
    id = "screen.demo.a11y.links.compose",
    composableName = "ComposeSemanticLinksDemoScreen",
  ) {
    var lastActivated by remember { mutableStateOf("None") }
    val linkStyle =
      remember {
        TextLinkStyles(style = SpanStyle(textDecoration = TextDecoration.Underline))
      }
    val inlineLinks =
      remember(linkStyle) {
        buildComposeInlineLinks(linkStyle) { lastActivated = it }
      }
    val standaloneLink =
      remember(linkStyle) {
        buildComposeStandaloneLink(linkStyle) { lastActivated = it }
      }

    Scaffold(
      topBar = {
        TopAppBar(
          title = { Text(text = "Semantic Links: Compose") },
          navigationIcon = {
            IconButton(
              onClick = onNavigateBack,
              modifier = Modifier.semantics { testTag = "semantic_links_compose_back" },
            ) {
              Icon(
                imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                contentDescription = "Back",
              )
            }
          },
        )
      }
    ) { paddingValues ->
      Column(
        modifier =
          Modifier.fillMaxSize()
            .padding(paddingValues)
            .padding(16.dp)
            .verticalScroll(rememberScrollState())
            .semantics {
              testTag = "semantic_links_compose_content"
              testTagsAsResourceId = true
            },
        verticalArrangement = Arrangement.spacedBy(16.dp),
      ) {
        Text(
          text = "This screen uses AnnotatedString and LinkAnnotation links.",
          style = MaterialTheme.typography.bodyLarge,
        )
        Text(
          text = inlineLinks,
          style = MaterialTheme.typography.bodyLarge,
          modifier = Modifier.semantics { testTag = "semantic_links_compose_paragraph" },
        )
        Text(
          text = standaloneLink,
          style = MaterialTheme.typography.bodyLarge,
          modifier = Modifier.semantics { testTag = "semantic_links_compose_standalone" },
        )
        Text(
          text = "Last activated: $lastActivated",
          style = MaterialTheme.typography.titleMedium,
          modifier = Modifier.semantics { testTag = "semantic_links_result" },
        )
      }
    }
  }
}

private fun View.bindXmlSemanticLinks() {
  importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
  val textColor =
    if (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
        Configuration.UI_MODE_NIGHT_YES
    ) {
      android.graphics.Color.WHITE
    } else {
      android.graphics.Color.BLACK
  }
  findViewById<TextView>(R.id.semantic_links_xml_description).setTextColor(textColor)
  val result = findViewById<TextView>(R.id.semantic_links_result)
  result.setTextColor(textColor)
  findViewById<TextView>(R.id.semantic_links_xml_paragraph).apply {
    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
    setTextColor(textColor)
    text = createXmlInlineLinks { result.text = "Last activated: $it" }
    movementMethod = LinkMovementMethod.getInstance()
  }
  findViewById<TextView>(R.id.semantic_links_xml_standalone).apply {
    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
    setTextColor(textColor)
    text = createXmlStandaloneLink { result.text = "Last activated: $it" }
    movementMethod = LinkMovementMethod.getInstance()
  }
}

private fun createXmlInlineLinks(onActivated: (String) -> Unit): SpannableString {
  val links = SpannableString(XmlInlineLinksText)
  links.setSpan(
    ResultClickableSpan("$TermsOfService (first)", onActivated),
    XmlInlineLinksText.indexOf(TermsOfService),
    XmlInlineLinksText.indexOf(TermsOfService) + TermsOfService.length,
    SpannableString.SPAN_EXCLUSIVE_EXCLUSIVE,
  )
  val secondStart = XmlInlineLinksText.lastIndexOf(TermsOfService)
  links.setSpan(
    ResultClickableSpan("$TermsOfService (second)", onActivated),
    secondStart,
    secondStart + TermsOfService.length,
    SpannableString.SPAN_EXCLUSIVE_EXCLUSIVE,
  )
  return links
}

private fun createXmlStandaloneLink(onActivated: (String) -> Unit): SpannableString {
  return SpannableString(PrivacyPolicy).apply {
    setSpan(
      ResultClickableSpan(PrivacyPolicy, onActivated),
      0,
      length,
      SpannableString.SPAN_EXCLUSIVE_EXCLUSIVE,
    )
  }
}

private fun buildComposeInlineLinks(
  linkStyle: TextLinkStyles,
  onActivated: (String) -> Unit,
): AnnotatedString =
  buildAnnotatedString {
    append("Read our ")
    withLink(composeLink("terms-first", "$TermsOfService (first)", linkStyle, onActivated)) {
      append(TermsOfService)
    }
    append(" before continuing, then review the ")
    withLink(composeLink("terms-second", "$TermsOfService (second)", linkStyle, onActivated)) {
      append(TermsOfService)
    }
    append(" for updates.")
  }

private fun buildComposeStandaloneLink(
  linkStyle: TextLinkStyles,
  onActivated: (String) -> Unit,
): AnnotatedString =
  buildAnnotatedString {
    withLink(composeLink("privacy", PrivacyPolicy, linkStyle, onActivated)) {
      append(PrivacyPolicy)
    }
  }

private fun composeLink(
  tag: String,
  result: String,
  linkStyle: TextLinkStyles,
  onActivated: (String) -> Unit,
): LinkAnnotation.Clickable =
  LinkAnnotation.Clickable(
    tag = tag,
    styles = linkStyle,
    linkInteractionListener = LinkInteractionListener { onActivated(result) },
  )

private class ResultClickableSpan(
  private val result: String,
  private val onActivated: (String) -> Unit,
) : ClickableSpan() {
  override fun onClick(widget: View) = onActivated(result)
}
