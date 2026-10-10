package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeCondition
import dev.jasonpearson.automobile.protocol.PrototypeDecrementAction
import dev.jasonpearson.automobile.protocol.PrototypeIncrementAction
import dev.jasonpearson.automobile.protocol.PrototypeScalar
import dev.jasonpearson.automobile.protocol.PrototypeStyle
import dev.jasonpearson.automobile.protocol.PrototypeStyleWhen
import dev.jasonpearson.automobile.protocol.PrototypeToggleAction

/**
 * Pure evaluation of the spec's state vocabulary: conditions for `visibleWhen` and the next value
 * for state-changing actions. The validator guarantees exactly one form per condition; a state key
 * of the wrong type simply fails numeric comparisons instead of throwing.
 */
internal fun PrototypeCondition.holds(state: Map<String, PrototypeScalar>): Boolean {
  val stored = key?.let { state[it] }
  val number = (stored as? PrototypeScalar.Numeric)?.value
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
internal fun PrototypeToggleAction.nextValue(
  state: Map<String, PrototypeScalar>,
): PrototypeScalar? =
  (state[key] as? PrototypeScalar.BooleanValue)?.let { PrototypeScalar.BooleanValue(!it.value) }

/** The stepped value, or null when the key is not numeric or the result would not be finite. */
internal fun PrototypeIncrementAction.nextValue(
  state: Map<String, PrototypeScalar>,
): PrototypeScalar? {
  val current = (state[key] as? PrototypeScalar.Numeric)?.value ?: return null
  val next = current + (by ?: 1.0)
  return if (next.isFinite()) PrototypeScalar.Numeric(next) else null
}

/** The stepped-down value: [PrototypeIncrementAction] with the sign of `by` flipped (default 1). */
internal fun PrototypeDecrementAction.nextValue(
  state: Map<String, PrototypeScalar>,
): PrototypeScalar? {
  val current = (state[key] as? PrototypeScalar.Numeric)?.value ?: return null
  val next = current - (by ?: 1.0)
  return if (next.isFinite()) PrototypeScalar.Numeric(next) else null
}

/**
 * The base style with every `styleWhen` entry whose condition holds merged over it, in authored
 * order, so a later matching entry wins per property. A present property replaces the base value as
 * a whole (`padding`, `border`, `offset` and per-corner `cornerRadius` are replaced, not merged
 * field by field).
 */
internal fun resolvePrototypeStyle(
  base: PrototypeStyle?,
  styleWhen: List<PrototypeStyleWhen>?,
  state: Map<String, PrototypeScalar>,
): PrototypeStyle {
  var resolved = base ?: PrototypeStyle()
  for (entry in styleWhen.orEmpty()) {
    if (entry.`when`.holds(state)) resolved = resolved.mergedOver(entry.style)
  }
  return resolved
}

/** Properties set on [prototype] win; unset ones keep this style's value. */
private fun PrototypeStyle.mergedOver(prototype: PrototypeStyle): PrototypeStyle =
  PrototypeStyle(
    width = prototype.width ?: width,
    height = prototype.height ?: height,
    weight = prototype.weight ?: weight,
    minWidth = prototype.minWidth ?: minWidth,
    maxWidth = prototype.maxWidth ?: maxWidth,
    minHeight = prototype.minHeight ?: minHeight,
    maxHeight = prototype.maxHeight ?: maxHeight,
    padding = prototype.padding ?: padding,
    background = prototype.background ?: background,
    cornerRadius = prototype.cornerRadius ?: cornerRadius,
    border = prototype.border ?: border,
    elevation = prototype.elevation ?: elevation,
    shadowColor = prototype.shadowColor ?: shadowColor,
    gradient = prototype.gradient ?: gradient,
    aspectRatio = prototype.aspectRatio ?: aspectRatio,
    offset = prototype.offset ?: offset,
    alpha = prototype.alpha ?: alpha,
    pressScale = prototype.pressScale ?: pressScale,
    alignment = prototype.alignment ?: alignment,
    arrangement = prototype.arrangement ?: arrangement,
    spacing = prototype.spacing ?: spacing,
    textSize = prototype.textSize ?: textSize,
    fontWeight = prototype.fontWeight ?: fontWeight,
    color = prototype.color ?: color,
    textAlign = prototype.textAlign ?: textAlign,
    maxLines = prototype.maxLines ?: maxLines,
    lineHeight = prototype.lineHeight ?: lineHeight,
    letterSpacing = prototype.letterSpacing ?: letterSpacing,
    textDecoration = prototype.textDecoration ?: textDecoration,
    fontStyle = prototype.fontStyle ?: fontStyle,
    overflow = prototype.overflow ?: overflow,
    fontFamily = prototype.fontFamily ?: fontFamily,
    textStyle = prototype.textStyle ?: textStyle,
  )
