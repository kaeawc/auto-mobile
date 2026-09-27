"""Turn GitHub-readable headings into Material tabs on the MkDocs site.

The source keeps ordinary headings inside a markdown-enabled div so GitHub
renders every platform. After inline Markdown is parsed, this extension moves
those headings into Material's alternate-style tab structure before TOC runs.
"""

import xml.etree.ElementTree as etree
from html.parser import HTMLParser

from markdown import Extension
from markdown.postprocessors import Postprocessor
from markdown.treeprocessors import Treeprocessor

HEADINGS = {f"h{level}" for level in range(1, 7)}


class ContentTabsError(ValueError):
    """A content-tabs div does not contain a usable tab group."""


class _UnconvertedContentTabsFinder(HTMLParser):
    def handle_starttag(self, tag, attrs):
        self._check(attrs)

    def handle_startendtag(self, tag, attrs):
        self._check(attrs)

    @staticmethod
    def _check(attrs):
        if any(
            name == "class" and "content-tabs" in (value or "").split()
            for name, value in attrs
        ):
            raise ContentTabsError(
                'content-tabs div was not converted; add the markdown attribute: '
                '<div class="content-tabs" markdown>'
            )


class UnconvertedContentTabsPostprocessor(Postprocessor):
    def run(self, text):
        _UnconvertedContentTabsFinder().feed(text)
        return text


class ContentTabsProcessor(Treeprocessor):
    def __init__(self, md):
        super().__init__(md)
        self.set_count = 0

    def run(self, root):
        self.set_count = 0
        self._walk(root)
        return root

    def _walk(self, parent):
        for index, child in enumerate(list(parent)):
            if child.tag == "div" and "content-tabs" in child.get("class", "").split():
                child = self._convert(child)
                parent[index] = child
            self._walk(child)

    def _convert(self, source):
        children = list(source)
        first = children[0] if children else None
        label = "".join(first.itertext()).strip() if first is not None else "empty"
        context = label or "empty"
        if source.text and source.text.strip():
            raise ContentTabsError(f"content-tabs ({context}): text before the first heading")
        if first is None or first.tag not in HEADINGS:
            raise ContentTabsError(f"content-tabs ({context}): first element must be a heading")

        headings = [child for child in children if child.tag == first.tag]
        if len(headings) < 2:
            raise ContentTabsError(f"content-tabs ({context}): expected at least two tabs")

        self.set_count += 1
        set_number = self.set_count
        count = len(headings)
        result = etree.Element(
            "div", {"class": "tabbed-set tabbed-alternate", "data-tabs": f"{set_number}:{count}"}
        )
        result.tail = source.tail
        labels = etree.Element("div", {"class": "tabbed-labels"})
        content = etree.Element("div", {"class": "tabbed-content"})
        for tab_number, heading in enumerate(headings, 1):
            tab_id = f"__tabbed_{set_number}_{tab_number}"
            attributes = {"name": f"__tabbed_{set_number}", "type": "radio", "id": tab_id}
            if tab_number == 1:
                attributes["checked"] = "checked"
            etree.SubElement(result, "input", attributes)
            label_element = etree.SubElement(labels, "label", {"for": tab_id})
            label_element.text = heading.text
            label_element.extend(list(heading))
            block = etree.SubElement(content, "div", {"class": "tabbed-block"})
            block.text = heading.tail
            start = children.index(heading) + 1
            end = children.index(headings[tab_number]) if tab_number < count else len(children)
            block.extend(children[start:end])
        result.extend((labels, content))
        return result


class ContentTabsExtension(Extension):
    def extendMarkdown(self, md):
        md.treeprocessors.register(ContentTabsProcessor(md), "content_tabs", 15)
        md.postprocessors.register(UnconvertedContentTabsPostprocessor(md), "content_tabs_unconverted", 5)


def on_config(config, **kwargs):
    config.markdown_extensions.append(ContentTabsExtension())
    return config
