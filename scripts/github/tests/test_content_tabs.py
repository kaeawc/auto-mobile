"""Tests for GitHub-readable content tabs rendered as Material tabs."""

import unittest
import xml.etree.ElementTree as etree

import markdown

from auto_mobile_docs.content_tabs import ContentTabsError, ContentTabsExtension, ContentTabsProcessor


class ContentTabsTest(unittest.TestCase):
    def setUp(self):
        self.md = markdown.Markdown(extensions=["md_in_html", ContentTabsExtension(), "toc"])

    def render(self, text):
        return etree.fromstring(f"<root>{self.md.convert(text)}</root>")

    def test_material_structure_labels_and_body(self):
        root = self.render(
            '<div class="other content-tabs" markdown>\n\n'
            '### `Android` **app**\n\nIntro.\n\n#### Detail\n\nMore.\n\n'
            '### iOS\n\nSecond.\n\n</div>\n\nOutside.\n'
        )
        tabs = root.find("div")
        self.assertEqual(tabs.attrib, {"class": "tabbed-set tabbed-alternate", "data-tabs": "1:2"})
        self.assertEqual([child.tag for child in tabs], ["input", "input", "div", "div"])
        inputs = tabs.findall("input")
        self.assertEqual([item.get("id") for item in inputs], ["__tabbed_1_1", "__tabbed_1_2"])
        self.assertEqual([item.get("name") for item in inputs], ["__tabbed_1"] * 2)
        self.assertEqual(inputs[0].get("checked"), "checked")
        self.assertNotIn("checked", inputs[1].attrib)
        labels = tabs.find("./div[@class='tabbed-labels']")
        self.assertEqual([item.get("for") for item in labels], [item.get("id") for item in inputs])
        self.assertEqual(etree.tostring(labels[0], encoding="unicode"),
                         '<label for="__tabbed_1_1"><code>Android</code> <strong>app</strong></label>')
        blocks = tabs.find("./div[@class='tabbed-content']")
        self.assertEqual([item.get("class") for item in blocks], ["tabbed-block"] * 2)
        self.assertEqual([child.tag for child in blocks[0]], ["p", "h4", "p"])
        self.assertEqual("".join(blocks[1].itertext()).strip(), "Second.")
        self.assertEqual(root[-1].text, "Outside.")
        self.assertNotIn("Android", [item.text for item in root.iter("h3")])

    def test_missing_markdown_attribute_is_rejected_after_raw_html_restore(self):
        source = (
            '<div class="content-tabs">\n\n'
            '### Android\n\nOne.\n\n### iOS\n\nTwo.\n\n</div>\n'
        )
        with self.assertRaisesRegex(ContentTabsError, "add the markdown attribute"):
            self.md.convert(source)

    def test_content_tabs_markup_inside_fenced_code_is_ignored(self):
        md = markdown.Markdown(
            extensions=["fenced_code", "md_in_html", ContentTabsExtension(), "toc"]
        )
        html = md.convert('```html\n<div class="content-tabs">\n```')
        self.assertIn('&lt;div class=&quot;content-tabs&quot;&gt;', html)

    def test_multiple_groups_reset_and_nested_group(self):
        source = (
            '<div class="content-tabs" markdown>\n\n'
            '## First\n\n<div class="content-tabs" markdown>\n\n'
            '### Inner A\n\nA.\n\n### Inner B\n\nB.\n\n</div>\n\n'
            '## Second\n\nC.\n\n</div>\n'
        )
        root = self.render(source)
        self.assertEqual([item.get("data-tabs") for item in root.iter("div")
                          if "tabbed-set" in item.get("class", "").split()], ["1:2", "2:2"])
        self.md.reset()
        root = self.render(source)
        self.assertEqual([item.get("data-tabs") for item in root.iter("div")
                          if "tabbed-set" in item.get("class", "").split()], ["1:2", "2:2"])

    def test_malformed_groups(self):
        cases = [
            ('<div class="content-tabs" markdown>\n\n</div>', "empty"),
            ('<div class="content-tabs" markdown>\n\nText.\n\n## iOS\n\n</div>', "first element"),
            ('<div class="content-tabs" markdown>\n\n## Android\n\nBody.\n\n</div>', "Android"),
            ('<div class="content-tabs" markdown>Lead\n\n## Android\n\n## iOS\n\n</div>', "first element"),
        ]
        for source, message in cases:
            with self.subTest(source=source), self.assertRaisesRegex(ContentTabsError, message):
                self.md.convert(source)
                self.md.reset()

    def test_direct_text_before_heading_is_rejected(self):
        source = etree.fromstring(
            '<div class="content-tabs">Lead<h2>Android</h2><h2>iOS</h2></div>'
        )
        with self.assertRaisesRegex(ContentTabsError, "text before the first heading"):
            ContentTabsProcessor(self.md)._convert(source)


if __name__ == "__main__":
    unittest.main()
