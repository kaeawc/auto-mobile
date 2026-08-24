package dev.jasonpearson.automobile.desktop.core.layout

import dev.jasonpearson.automobile.desktop.core.clipboard.ClipboardWriter

/**
 * Build an automation-ready, XPath-like selector for a hierarchy [element] (#5205). Attribute
 * precedence — resource-id, then text, then content-desc, then class-only — mirrors the matching
 * order used elsewhere, so the emitted selector resolves back to the same element. Deterministic
 * and pure so it can be unit-tested in isolation and shared between the hierarchy tree and the
 * property inspector.
 */
internal fun buildElementSelector(element: UIElementInfo): String {
  val simpleName = element.className.substringAfterLast(".")
  return when {
    !element.resourceId.isNullOrEmpty() -> "//$simpleName[@resource-id='${element.resourceId}']"
    !element.text.isNullOrEmpty() -> "//$simpleName[@text='${element.text}']"
    !element.contentDescription.isNullOrEmpty() ->
      "//$simpleName[@content-desc='${element.contentDescription}']"
    else -> "//$simpleName"
  }
}

/** Copy [element]'s automation-ready selector to [this] clipboard. */
internal fun ClipboardWriter.copyElementSelector(element: UIElementInfo) {
  writeText(buildElementSelector(element))
}
