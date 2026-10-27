/** Motion v3 section of the authoring guide, kept out of prototypeGuideProse.ts (file-size cap). */
export const GUIDE_MOTION_V3 = `## Expressive and layout motion

(needs \`prototype_motion_v3\`, Android only) \`motion: "expressive"\` uses Material expressive
springs for visibility, container size, press feedback and \`animate\` with \`easing: "spring"\`.
Spatial changes use the spatial spring; color and alpha use the effects spring. Standard remains
the default. Under \`animate\`, border color/width, cornerRadius, elevation, shadowColor, padding
and dp width/height also tween; fill/wrap/token, text, font and gradient swaps stay instant.
Node \`press: {scale?, alpha?}\` needs at least one field: scale 0.85–1, alpha 0.5–1, on a node
with a tap/long-press/double-tap or an inherently pressable control. Its scale overrides style
\`pressScale\`; drawing changes without shrinking the touch target or reported bounds.
With motion none or Android animator scale 0, controls settle instantly and ripples are disabled.
The host refuses these features against the iOS agent until #14684.
`;
