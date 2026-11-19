/** Material 3 Expressive section of the authoring guide (#15258), kept out of prototypeGuideProse.ts (file-size cap). */
export const GUIDE_M3_EXPRESSIVE = `## Material 3 Expressive components

These require \`prototype_m3_expressive_v1\` (Android only; the host refuses them on iOS):

- \`segmentedButton.variant: "connected"\` (default \`standard\`) draws a connected button group; the selected segment morphs to a full pill.
- \`button.split: {menu}\` draws a split button. \`onTap\` stays the leading action; the trailing half (tag \`<testTag>.menu\`) opens 1..16 menu entries, the same entries as \`menu.items\`.
- \`fab.menu: {items}\` takes 2..6 \`{icon, label, onTap}\` items. Tapping the FAB opens or closes them above it, and an item tap closes the menu, then runs its \`onTap\`. Items are tagged \`<testTag>.items.<index>\`. The FAB's own \`onTap\` runs first when set.
- \`progress.variant: "wavy"\` draws a linear progress with a wavy active track; determinate with \`stateKey\`, otherwise indeterminate.
- \`loadingIndicator\` is an indeterminate, shape-morphing indicator; \`contained: true\` draws it on a filled container.

Shape changes and expansion use the expressive spatial springs, colour changes the effects springs, and everything snaps when motion is off.

`;
