# Prototype web preview

Read a prototype as a web page, or keep a live browser preview open while an agent iterates.
You can also export the page to a file, or take the spec with its renderer requirements. To put a prototype in a real
app, see [Embedding a prototype in an app](prototype-embedding.md).

## Preview as a web page

To look at a prototype without a device or an app, read `automobile:prototype/<id>/web`. It is one
self-contained HTML page (`text/html`, no network access) with:

- the prototype in a device frame
- rotate and zoom controls
- a screen picker when the prototype's stack has more than one screen
- its revision history

| Parameter      | Meaning                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| `frame`        | A device frame id such as `pixel-9` or `iphone-16`. Defaults to the platform that showed the prototype. |
| `revision`     | A kept revision. Defaults to the latest.                                                                |
| `variant`      | The prototype id of the alternative to show first (see below).                                          |
| `mcpSessionId` | Only revisions this MCP session produced (see below). Defaults to every session's.                      |

Revision 1 is the first show of the id. Each later show and each patch that lands adds one; taps
and typing on the device do not. AutoMobile keeps the last 20 revisions. Asking for an older one
returns an error that names the oldest kept revision.

The result's `_meta` reports:

| Field             | Meaning                                                                     |
| ----------------- | --------------------------------------------------------------------------- |
| `revision`        | The revision shown.                                                         |
| `deviceRevision`  | The device's own counter for that patch.                                    |
| `mcpSessionId`    | The MCP session whose show or patch produced the revision, when it had one. |
| `revisions`       | The kept revisions.                                                         |
| `variants`        | The alternatives in the prototype's `variant` group.                        |
| `frame`           | The device frame drawn.                                                     |
| `sha256`          | The page's hash.                                                            |
| `rendererVersion` | The renderer that drew the page.                                            |

Every MCP session on the daemon shares one revision history, so another session's show can land
between yours and your read. A successful `show` or `patch` returns `mcpSessionId`. Pass it as the
`mcpSessionId` parameter to read only your session's revisions:

- The default revision is then your latest.
- `revisions` lists only yours.
- A `revision` another session produced is an error.

The page itself still offers every kept revision.

Images draw the assets uploaded with the prototype to an Android device that is still showing it,
re-encoded at the size the frame draws them. The page stays under 2 MiB, and the revision shown
first gets its images before older revisions. A grey placeholder replaces an image that does not
fit, or whose asset the server does not have (iOS uploads, or no device showing the prototype any
more). Upload the assets again with the next show to bring them back.

`resources/list` lists `automobile:prototype/<id>/web` for every prototype shown in this daemon
session. Subscribe to that URI, without parameters, to hear about every new revision. A
subscription to a URI with `revision=` never gets another notification.

To compare design alternatives, show each under its own id with the same `variant` group, for
example `variant: {group: "checkout", label: "Compact"}`. The web page of any of them offers every
alternative in the group by its label. The device keeps showing whichever was shown last.

## Live preview in a browser

To keep a browser tab on a prototype while an agent iterates, call `prototype` with
`{action: "serve", id: "<id>"}`. It needs no device request and works the same on a device and in
[headless mode](prototype-headless.md). It returns `previewServer` with `pageUrl` (the live page
for that id) and `url` (an index of every prototype shown in this daemon).

Each `show` and each `patch` that lands reloads the open page within about a second, keeping the
variant picked in its switcher. The page is the same HTML as `automobile:prototype/<id>/web`. Add
`?frame=<frame id>` or `?variant=<id>` to the page URL to choose them. Serving an id not shown yet
succeeds with a warning, and its page loads once it is shown.

| Parameter       | Meaning                                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`            | The prototype whose page URL to return. Optional: without it, use the index `url`.                                                                                                               |
| `port`          | TCP port, `0` to `65535`. `0` or absent picks a free port. If the port is in use, the call fails: pass another port or omit it.                                                                  |
| `remote`        | `true` binds every network interface so other machines can open the preview at this host's address. Anyone who can reach the port sees every shown prototype. Default `false`: `127.0.0.1` only. |
| `idleTimeoutMs` | Stop after this long with no open preview page and no request, `show` or `patch`. `1000` to `86400000`, default `1800000` (30 minutes).                                                          |

One preview server runs per daemon and every MCP session shares it. Calling `serve` while it runs
returns the same server; a different `port` or `remote` value restarts it on the new address. A
loopback server answers only requests addressed to `127.0.0.1`, `localhost` or `[::1]`.

`{action: "stop"}` closes the port and the open pages' connections. The server also stops when the
daemon exits, and after the idle timeout. After the first `serve`, `status` reports
`previewServer`: `running`, `url`, `port`, `host`, `remote`, `idleTimeoutMs`, or `stoppedReason`
(`stop`, `idle` or `daemon`). After the server stops, call `serve` again for a new URL.

## Export the web page to a file

To host the page, attach it to a CI run or send it to someone without a device, call the
`exportPrototypeWeb` tool. It is off by default: enable it with `setToolEnabled` (see
[Dynamic tools](dynamic-tools.md)). It needs no device. It writes the same bytes the
`automobile:prototype/<id>/web` resource returns for the same parameters, with no network access
and the same Content Security Policy. It returns the file's details instead of the HTML.

| Parameter                                      | Meaning                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                                           | The shown prototype's id. Required.                                                                                                                                                                                                                          |
| `frame`, `revision`, `variant`, `mcpSessionId` | As for the resource above.                                                                                                                                                                                                                                   |
| `outputPath`                                   | An absolute `.html` file path, or a directory (an existing one, or a path ending in `/`); any other path is refused. Defaults to `prototype-web/` in the AutoMobile data directory. In a directory the file is named `<id>-<frame>-r<revision>-<hash>.html`. |
| `overwrite`                                    | `true` replaces an existing file with different content; a symlink at `outputPath` is replaced, not written through. Without it the call is refused and nothing is written. A file that already holds the same bytes is left as it is.                       |

The result is `{path, sha256, bytes, frame, revision, variants, rendererVersion}`. `sha256` is the
hash of the written file and matches the resource's `_meta.sha256`. The page already offers every
variant in its group, so one file covers the whole set.

Errors name what to change:

- An unknown id lists the known prototypes.
- A revision older than the kept 20 names the oldest kept one.
- An unknown frame lists the valid frames.
- A relative or unwritable `outputPath` asks for a writable absolute path.
- A file path that does not end in `.html` asks for an `.html` file or a directory.

## Embed envelope

To take a prototype's spec together with what it needs from a renderer, read
`automobile:prototype/<id>/embed` (`application/json`). It returns:

```json
{
  "format": "automobile-prototype-embed",
  "version": 1,
  "requires": ["..."],
  "spec": { "...": "..." },
  "glyphs": { "filled/home": "<path d=\"...\"></path>" },
  "iconMissing": ["filled/..."]
}
```

`spec` is the prototype's spec, and `requires` lists the renderer capabilities it needs, as this
server computed them. Keep the two together: a renderer that lacks a listed capability should
refuse the spec rather than draw part of it. A `version` other than `1` is a newer format.

`glyphs` is present when the spec names an icon that has a glyph. It maps `<variant>/<name>` to the
Material Icons glyph's shapes, as SVG markup for a `0 0 24 24` viewBox, so a renderer needs no icon
set of its own. It covers:

- every icon the spec's icon fields name, in the icon's `variant` (else `filled`)
- the glyphs controls draw on their own: a filter chip's or segment's selection check, a select's
  dropdown arrow and a date picker's month arrows
- every icon name that appears as a string in `state` or `data`, in `filled` and in each variant
  the spec's icons use. An icon whose name changes with state still has its glyph.

A variant without that glyph carries the `filled` one. `iconMissing` lists the keys with no glyph
at all; draw a placeholder for them. iOS-style glyphs are not included yet.

`revision`, `variant` and `mcpSessionId` work as for the web page; there is no `frame`. Errors,
listing and subscriptions also match the web page, and `_meta` reports the same fields except
`frame`.
