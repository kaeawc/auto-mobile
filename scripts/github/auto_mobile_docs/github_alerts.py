"""MkDocs hook: render GitHub alert blockquotes as Material admonitions.

Docs under docs/ must render on github.com as well as on the MkDocs site, so
they use GitHub's alert syntax instead of MkDocs-only `!!! note` blocks:

    > [!NOTE]
    > Body text.

GitHub renders that natively. This hook registers a Python-Markdown tree
processor that rewrites the parsed <blockquote> into the markup the
`admonition` extension produces. It runs on the parsed tree rather than the
source text, so fenced code, blockquote nesting, and marker indentation are
decided by the same parser that renders the site.
"""

import re
import xml.etree.ElementTree as etree

from markdown import Extension
from markdown.treeprocessors import Treeprocessor

_MARKER = re.compile(r"^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)")

# GitHub alert type -> (Material admonition type, title).
_TYPES = {
    "NOTE": ("note", "Note"),
    "TIP": ("tip", "Tip"),
    "IMPORTANT": ("info", "Important"),
    "WARNING": ("warning", "Warning"),
    "CAUTION": ("danger", "Caution"),
}


class GithubAlertsTreeprocessor(Treeprocessor):
    def run(self, root):
        for quote in list(root.iter("blockquote")):
            if not len(quote) or quote[0].tag != "p":
                continue
            first = quote[0]
            match = _MARKER.match(first.text or "")
            if not match:
                continue
            kind, title = _TYPES[match.group(1)]
            first.text = first.text[match.end() :]
            if not first.text.strip() and not len(first):
                quote.remove(first)
            quote.tag = "div"
            quote.set("class", f"admonition {kind}")
            heading = etree.Element("p", {"class": "admonition-title"})
            heading.text = title
            quote.insert(0, heading)


class GithubAlertsExtension(Extension):
    def extendMarkdown(self, md):
        # Above the inline processor (20) so the marker is still raw text.
        md.treeprocessors.register(GithubAlertsTreeprocessor(md), "github_alerts", 25)


def on_config(config, **kwargs):
    config.markdown_extensions.append(GithubAlertsExtension())
    return config
