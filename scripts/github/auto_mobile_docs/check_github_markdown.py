"""Reject MkDocs-only Markdown in docs/ so pages also render on github.com.

Rather than pattern-matching source lines, render each page with the site's
own Markdown configuration (from mkdocs.yml) and again with one MkDocs-only
extension removed. If the output differs, the page uses that extension's
syntax, which GitHub shows as literal text. Fenced code, inline code,
blockquotes, and lists are therefore handled by the same parser that builds
the site. Raw <style>/<script> elements are found in the rendered HTML,
where code examples are already escaped.

Usage: python -m auto_mobile_docs.check_github_markdown [mkdocs.yml] [docs dir]
"""

import sys
from html.parser import HTMLParser
from pathlib import Path

import markdown

# Extension -> what to use instead. Only those enabled in mkdocs.yml matter:
# a disabled extension renders its syntax literally on the site as well.
MKDOCS_ONLY = {
    "admonition": "!!! admonition (use > [!NOTE])",
    "pymdownx.details": '??? collapsible (use <details markdown="1">)',
    "pymdownx.tabbed": '=== "Tab" (use headings)',
    "pymdownx.blocks.tab": "/// tab block (use headings)",
    "pymdownx.blocks.admonition": "/// admonition block (use > [!NOTE])",
    "pymdownx.blocks.details": '/// details block (use <details markdown="1">)',
    "attr_list": '{ .class } / { key=value } attr list (use <div class="..." markdown> or HTML)',
    "pymdownx.snippets": "--8<-- snippet include (link or inline the content)",
    "pymdownx.inlinehilite": "`#!lang code` inline highlighting (use plain `code`)",
    "pymdownx.caret": "^^insert^^ / ^superscript^ (use <ins> / <sup>)",
    "pymdownx.tilde": "~~delete~~ / ~subscript~ (use <sub>)",
    "pymdownx.mark": "==mark== (use <mark>)",
    "def_list": "definition list (use a table or bullets)",
}


class _RawTagFinder(HTMLParser):
    def __init__(self):
        super().__init__()
        self.found = set()

    def handle_starttag(self, tag, attrs):
        if tag in ("style", "script"):
            self.found.add(tag)


def load_markdown_settings(config_file):
    from mkdocs.config import load_config

    config = load_config(config_file=str(config_file))
    names = [ext for ext in config.markdown_extensions if isinstance(ext, str)]
    return names, config.mdx_configs


def render(text, names, configs):
    return markdown.Markdown(
        extensions=names,
        extension_configs={k: v for k, v in configs.items() if k in names},
    ).convert(text)


def check_text(text, names, configs):
    """Return the MkDocs-only constructs a page uses, as human-readable reasons."""
    full = render(text, names, configs)
    reasons = [
        MKDOCS_ONLY[ext]
        for ext in names
        if ext in MKDOCS_ONLY and render(text, [n for n in names if n != ext], configs) != full
    ]
    finder = _RawTagFinder()
    finder.feed(full)
    reasons += [f"inline <{tag}> (move to docs/assets via mkdocs.yml)" for tag in sorted(finder.found)]
    return reasons


def main(argv):
    root = Path(__file__).resolve().parents[3]
    config_file = Path(argv[1]) if len(argv) > 1 else root / "mkdocs.yml"
    docs_dir = Path(argv[2]) if len(argv) > 2 else root / "docs"
    names, configs = load_markdown_settings(config_file)
    failures = [
        f"{page}: {reason}"
        for page in sorted(docs_dir.rglob("*.md"))
        for reason in check_text(page.read_text(encoding="utf-8"), names, configs)
    ]
    if failures:
        print("error: MkDocs-only syntax in docs/ breaks GitHub rendering:", file=sys.stderr)
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("docs/ Markdown is GitHub-compatible.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
