# Docs navigation grouped by task and platform

- Kind: decision
- Date: 2026-11-17
- Source: owner request in the docs-organization session; this pull request
- Shaped: the site navigation in `mkdocs.yml`

## Context

The site sidebar listed 57 "Using AutoMobile" pages and about 150 "How it Works" pages as flat
siblings, and every page rendered the whole tree. Core usage sat beside niche form factors, host
plumbing and event kits. How it Works mixed subsystem design with pages only maintainers read, such
as CI attestation and installer signing. Most readers drive an agent against a phone and need a
handful of these pages.

## Options

- Group the sidebar by device type. The tool surface is shared across Android and iOS, so this
  would repeat the same guides per platform.
- Add one top-level tab per reader persona. The owner rejected persona tabs.
- Keep the three sections and group inside them by task, with device type as one "Platforms"
  group of landing pages.

## Decision

Keep the `using` / `how-it-works` / `devlog` split. Add a short "Get started" group, group "Using
AutoMobile" by task (explore, app and device state, audits, devices and sessions, CI hosts,
debugging, integrations, platforms, prototyping) and make "Tools" the reference group. Group "How
it Works" by subsystem (MCP server, sessions and devices, Android, Apple, prototyping platform),
with maintainer pages last under "Maintaining AutoMobile". Turn on Material's
`navigation.sections`, `navigation.indexes` and `navigation.prune`; leave `navigation.tabs` off.

Test authoring stays off the navigation until recording and authoring tests is easy. The UI test
pages and the JUnit and XCTestRunner runner pages are still built at their URLs but are not linked
from the sidebar or user guides.

Pages were not moved on disk, so no URL changed. Paired pages such as the device-ownership set and
"Apple Watch" / "Apple Watch tool behavior" stay split, because merging them would break the
1,500-word page budget for `using` pages. Page-level tags were not added: no page carries front
matter, and the tags index needs MkDocs-only syntax that pages rendered on GitHub cannot use.

## Consequences

- A new `using` page goes into the task group that matches what the reader is doing, or into
  "Platforms" when it is specific to one device family.
- Maintainer-only `how-it-works` pages go under "Maintaining AutoMobile".
- Pages kept off the sidebar are listed in both `not_in_nav` in `mkdocs.yml` and the exclusion list
  in `scripts/validate-mkdocs-nav.ts`.
