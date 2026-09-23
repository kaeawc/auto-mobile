"""MkDocs hook: render GitHub alert blockquotes as Material admonitions.

Docs under docs/ must render on github.com as well as on the MkDocs site, so
they use GitHub's alert syntax instead of MkDocs-only `!!! note` blocks:

    > [!NOTE]
    > Body text.

GitHub renders that natively, but only for a blockquote at the top level of
the document. This hook registers a Python-Markdown block processor that runs
just before the built-in blockquote processor, so it sees the same blocks
(fenced code is already stashed, `>` markers follow the parser's own rules).
For a top-level quote whose first line is an alert marker, it strips the
quote markers and the marker line and parses the body into the markup the
`admonition` extension produces. Nested quotes are left as plain quotes, as
on GitHub.
"""

import re
import xml.etree.ElementTree as etree

from markdown import Extension
from markdown.blockprocessors import BlockQuoteProcessor

_MARKER = re.compile(r"^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$")

# GitHub alert type -> (Material admonition type, title).
_TYPES = {
    "NOTE": ("note", "Note"),
    "TIP": ("tip", "Tip"),
    "IMPORTANT": ("info", "Important"),
    "WARNING": ("warning", "Warning"),
    "CAUTION": ("danger", "Caution"),
}


class GithubAlertsProcessor(BlockQuoteProcessor):
    def _alert(self, parent, block):
        """Return (start of the quote, alert type) for a top-level alert."""
        if parent is not self.parser.root:
            return None
        match = self.RE.search(block)
        if not match:
            return None
        marker = _MARKER.match(match.group(2))
        return (match.start(), marker.group(1)) if marker else None

    def test(self, parent, block):
        return self._alert(parent, block) is not None

    def run(self, parent, blocks):
        block = blocks.pop(0)
        start, alert = self._alert(parent, block)
        # Lines before the quote are ordinary blocks.
        self.parser.parseBlocks(parent, [block[:start]])
        lines = [self.clean(line) for line in block[start:].lstrip("\n").split("\n")]
        kind, title = _TYPES[alert]
        box = etree.SubElement(parent, "div", {"class": f"admonition {kind}"})
        etree.SubElement(box, "p", {"class": "admonition-title"}).text = title
        self.parser.state.set("blockquote")
        self.parser.parseChunk(box, "\n".join(lines[1:]))
        self.parser.state.reset()


class GithubAlertsExtension(Extension):
    def extendMarkdown(self, md):
        # Just above the built-in blockquote processor (20).
        md.parser.blockprocessors.register(GithubAlertsProcessor(md.parser), "github_alerts", 21)


def on_config(config, **kwargs):
    config.markdown_extensions.append(GithubAlertsExtension())
    return config
