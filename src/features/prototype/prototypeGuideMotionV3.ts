import contract from "../../../schemas/prototype-spec-contract.json";

const motionTokenGuideRows = (["standard", "expressive"] as const)
  .flatMap((scheme) =>
    (["spatial", "effects"] as const).map((role) => {
      const tokens = (["fast", "default", "slow"] as const).map(
        (tempo) => contract.motionTokens[scheme][role][tempo],
      );
      return `| ${scheme} ${role} | ${tokens.map((token) => token.dampingRatio).join(" / ")} | ${tokens.map((token) => token.stiffness).join(" / ")} |`;
    }),
  )
  .join("\n");

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

Text nodes accept \`contentTransition: "numeric" | "crossfade" | "none"\` (default \`none\`). Non-\`none\` requires \`prototype_content_transition_v1\`. Numeric changes roll only changed characters up for an increase and down for a decrease; formatting is stripped to digits, the first decimal point and a leading minus. Missing or equal numeric values crossfade; identical text stays still. Spans crossfade as a whole. Roll uses a spring (Android damping 0.8, stiffness 380; iOS duration 0.35 s, bounce 0.15); fades take 200 ms. Accessibility and observe expose the new text immediately. Android reduced motion uses fades and motion off snaps; iOS content transitions snap under reduced motion or motion off.

\`animate.tempo: "fast" | "default" | "slow"\` requires \`prototype_motion_tokens_v1\`
and cannot be combined with \`durationMs\` or \`easing\`. The contract's \`motionTokens\`
table selects a physical spring by scheme (\`motion: "standard"\` by default, or
\`"expressive"\`), property role and tempo. \`easing: "spring"\` selects the default
tempo of that scheme. Spatial properties are offset, scale, rotation, cornerRadius,
elevation, shadowColor, padding, border width and dp width/height; alpha, background,
color and border color use critically damped effects springs.

| Scheme / role | Damping ratio (fast / default / slow) | Stiffness (fast / default / slow) |
| --- | --- | --- |
${motionTokenGuideRows}

Compose uses \`spring(dampingRatio, stiffness)\`. SwiftUI uses
\`interpolatingSpring(mass: 1, stiffness: k, damping: 2 * dampingRatio * sqrt(k))\`,
so both renderers use the same physical spring. Reduced motion snaps spatial
changes and retains effects; motion off snaps everything. Existing motion v2/v3
capability requirements still apply; iOS advertises the token capability but
continues to refuse those broader features until its corresponding capabilities
are available.

## Attention loops

(Android only, requires \`prototype_loops_v1\`) Any node accepts
\`loop: {effect: "pulse" | "spin", periodMs: 400–4000, iterations?: 1–20 | "infinite"}\`.
The period and finite count are integers; omitted iterations means infinite. Pulse scales
1 → 1.08 → 1 per period; spin turns 0 → 360 degrees. Drawing changes without changing
layout, reported bounds or touch targets. A pulse node must omit \`style.scale\`; a spin node
must omit \`style.rotation\`, including every \`styleWhen\` style. At most eight expanded nodes
may carry loops, including repeat instances; shimmer does not consume that limit.
Finite loops settle at identity and contribute to settling motion while running. Infinite
loops and shimmer contribute only to the intentional loop count. Reduced motion, motion
none and animator scale 0 leave loops at rest. On Android each observe metadata read renews
a 1500 ms capture hold: attention loops draw identity and shimmer draws no band during it,
so captures within the hold are identical when the rest of the scene is unchanged.
`;
