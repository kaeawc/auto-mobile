package dev.jasonpearson.automobile.ctrlproxy.overlay

import dev.jasonpearson.automobile.protocol.OverlayCondition
import dev.jasonpearson.automobile.protocol.OverlayIncrementAction
import dev.jasonpearson.automobile.protocol.OverlayScalar
import dev.jasonpearson.automobile.protocol.OverlayStyle
import dev.jasonpearson.automobile.protocol.OverlayStyleWhen
import dev.jasonpearson.automobile.protocol.OverlayToggleAction

/**
 * Pure evaluation of the spec's state vocabulary: conditions for `visibleWhen` and the next value
 * for state-changing actions. The validator guarantees exactly one form per condition; a state key
 * of the wrong type simply fails numeric comparisons instead of throwing.
 */
internal fun OverlayCondition.holds(state: Map<String, OverlayScalar>): Boolean {
  val stored = key?.let { state[it] }
  val number = (stored as? OverlayScalar.Numeric)?.value
  val all = all
  val any = any
  val not = not
  val gt = gt
  val lt = lt
  return when {
    key != null && equals != null -> stored == equals
    key != null && notEquals != null -> stored != notEquals
    gt != null -> number != null && number > gt
    lt != null -> number != null && number < lt
    all != null -> all.all { it.holds(state) }
    any != null -> any.any { it.holds(state) }
    not != null -> !not.holds(state)
    else -> false
  }
}

/** The flipped value, or null when the key no longer holds a boolean (the action is a no-op). */
internal fun OverlayToggleAction.nextValue(state: Map<String, OverlayScalar>): OverlayScalar? =
  (state[key] as? OverlayScalar.BooleanValue)?.let { OverlayScalar.BooleanValue(!it.value) }

/** The stepped value, or null when the key is not numeric or the result would not be finite. */
internal fun OverlayIncrementAction.nextValue(state: Map<String, OverlayScalar>): OverlayScalar? {
  val current = (state[key] as? OverlayScalar.Numeric)?.value ?: return null
  val next = current + (by ?: 1.0)
  return if (next.isFinite()) OverlayScalar.Numeric(next) else null
}

/**
 * The base style with every `styleWhen` entry whose condition holds merged over it, in authored
 * order, so a later matching entry wins per property. A present property replaces the base value as
 * a whole (`padding` and `border` are replaced, not merged edge by edge).
 */
internal fun resolveOverlayStyle(
  base: OverlayStyle?,
  styleWhen: List<OverlayStyleWhen>?,
  state: Map<String, OverlayScalar>,
): OverlayStyle {
  var resolved = base ?: OverlayStyle()
  for (entry in styleWhen.orEmpty()) {
    if (entry.`when`.holds(state)) resolved = resolved.mergedOver(entry.style)
  }
  return resolved
}

/** Properties set on [overlay] win; unset ones keep this style's value. */
private fun OverlayStyle.mergedOver(overlay: OverlayStyle): OverlayStyle =
  OverlayStyle(
    width = overlay.width ?: width,
    height = overlay.height ?: height,
    padding = overlay.padding ?: padding,
    background = overlay.background ?: background,
    cornerRadius = overlay.cornerRadius ?: cornerRadius,
    border = overlay.border ?: border,
    elevation = overlay.elevation ?: elevation,
    gradient = overlay.gradient ?: gradient,
    aspectRatio = overlay.aspectRatio ?: aspectRatio,
    alpha = overlay.alpha ?: alpha,
    alignment = overlay.alignment ?: alignment,
    arrangement = overlay.arrangement ?: arrangement,
    spacing = overlay.spacing ?: spacing,
    textSize = overlay.textSize ?: textSize,
    fontWeight = overlay.fontWeight ?: fontWeight,
    color = overlay.color ?: color,
    textAlign = overlay.textAlign ?: textAlign,
    maxLines = overlay.maxLines ?: maxLines,
    fontFamily = overlay.fontFamily ?: fontFamily,
  )
