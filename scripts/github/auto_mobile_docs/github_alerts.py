"""MkDocs hook: render GitHub alert blockquotes as Material admonitions.

Docs under docs/ must render on github.com as well as on the MkDocs site, so
they use GitHub's alert syntax instead of MkDocs-only `!!! note` blocks:

    > [!NOTE]
    > Body text.

GitHub renders that natively; this hook rewrites it to the equivalent
`!!! note` admonition before MkDocs parses the page.
"""

import re

_ALERT = re.compile(r"^> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$")
_FENCE = re.compile(r"^\s*(```|~~~)")

# GitHub alert type -> (Material admonition type, title).
_TYPES = {
    "NOTE": ("note", "Note"),
    "TIP": ("tip", "Tip"),
    "IMPORTANT": ("info", "Important"),
    "WARNING": ("warning", "Warning"),
    "CAUTION": ("danger", "Caution"),
}


def convert(markdown: str) -> str:
    lines = markdown.split("\n")
    out = []
    in_fence = False
    i = 0
    while i < len(lines):
        line = lines[i]
        if _FENCE.match(line):
            in_fence = not in_fence
        match = None if in_fence else _ALERT.match(line)
        if not match:
            out.append(line)
            i += 1
            continue
        kind, title = _TYPES[match.group(1)]
        out.append(f'!!! {kind} "{title}"')
        out.append("")
        i += 1
        while i < len(lines) and lines[i].startswith(">"):
            body = lines[i][1:]
            body = body[1:] if body.startswith(" ") else body
            out.append(f"    {body}" if body else "")
            i += 1
        out.append("")
    return "\n".join(out)


def on_page_markdown(markdown, **kwargs):
    return convert(markdown)
