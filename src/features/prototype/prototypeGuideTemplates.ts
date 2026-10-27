export const GUIDE_TEMPLATES = `## Starter templates

The repository ships eight validated multi-screen specs, each a \`stack\` with a \`testTag\` on every
interactive node. In a checkout, show one with \`specPath\` (an absolute path) from
\`test/fixtures/prototype-spec/valid/\`, or copy its shape when writing a spec:

- \`template-onboarding.json\`: welcome, sign-up form with \`checks\`, a button gated by
  \`enabledWhen {valid}\`, \`emit\` with \`requireValid\`, done.
- \`template-feed-detail.json\`: a \`repeat\` over \`{path: "/posts"}\` inside a refreshable \`scroll\`; a
  tap stores the row in state and \`push\`es the detail screen.
- \`template-tabbed-home.json\`: a \`pager\` driven by a \`bottomNav {pager}\`, plus a pushed screen.
- \`template-checkout.json\`: quantity stepper, form with \`select\` and \`datePicker\`, and a
  \`bottomSheet\` confirmation.
- \`template-settings.json\`: \`listItem\` switches, \`radioGroup\`, \`slider\`, \`dialog\`, \`snackbar\` and
  a \`storage\` block.
- \`template-search.json\`: docked \`searchBar\` whose child lists \`/results\` and shows an empty
  state with \`{data, empty: true}\`.
- \`template-chat.json\`: reversed \`scroll\` with \`stickToEnd\`, quick-reply chips that
  \`appendData\`, and a composer that \`emit\`s \`message_sent\` with the draft as context (Android only).
- \`template-dashboard.json\`: \`chart\` line, bar and ring over \`/data\`, and a \`startTimer\` clock.
`;
