"""Tests for the docs GitHub-compatibility guard and the GitHub alerts hook.

Run from scripts/github: uv run --locked python -m unittest discover -s tests
"""

import unittest
from pathlib import Path

import markdown

from auto_mobile_docs.check_github_markdown import check_text, load_markdown_settings
from auto_mobile_docs.github_alerts import GithubAlertsExtension

MKDOCS_YML = Path(__file__).resolve().parents[3] / "mkdocs.yml"


class CheckGithubMarkdownTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.names, cls.configs = load_markdown_settings(MKDOCS_YML)

    def check(self, text):
        return check_text(text, self.names, self.configs)

    def assertFlags(self, text, fragment):
        reasons = self.check(text)
        self.assertTrue(any(fragment in r for r in reasons), f"{fragment!r} not in {reasons}")

    def test_github_compatible_constructs_pass(self):
        text = (
            "## Android\n\n> [!NOTE]\n> Body.\n\n"
            '<details markdown="1">\n<summary>More</summary>\n\nText.\n\n</details>\n\n'
            '<div class="example-demo" markdown>\n\n![demo](a.gif)\n\n</div>\n'
        )
        self.assertEqual(self.check(text), [])

    def test_flags_admonition(self):
        self.assertFlags('!!! note "Title"\n    Body.\n', "admonition")

    def test_flags_collapsible(self):
        self.assertFlags('??? note "Title"\n    Body.\n', "collapsible")

    def test_flags_attr_lists(self):
        self.assertFlags("![demo](a.gif){ .example-demo }\n", "attr list")
        self.assertFlags("[Link](https://example.com){ target=_blank } trailing prose\n", "attr list")
        self.assertFlags("## Heading {: #custom-id }\n", "attr list")

    def test_flags_style_and_script_including_multiline_start_tags(self):
        self.assertFlags("<style>\np { color: red; }\n</style>\n", "<style>")
        self.assertFlags('<style\n  type="text/css">\np {}\n</style>\n', "<style>")
        self.assertFlags("<script>\nrun();\n</script>\n", "<script>")

    def test_literal_examples_in_code_pass(self):
        cases = [
            '~~~markdown\n=== "Tab"\n!!! note\n<style></style>\n~~~\n',
            '````md\n```\n!!! note "x"\n```\n````\n',
            "Use ``!!! note`` and ``a ` b { .x }`` inline.\n",
            "> ```markdown\n> <style>\n> { .x }\n> ```\n",
            '- Example:\n\n    ```markdown\n    !!! note "Literal"\n    ```\n',
        ]
        for text in cases:
            with self.subTest(text=text):
                self.assertEqual(self.check(text), [])

    def test_admonition_line_inside_multiline_code_span_is_flagged(self):
        # GitHub treats this as one code span, but MkDocs' admonition
        # processor interrupts the paragraph, so the site breaks it.
        self.assertFlags('Use ``an example`\n!!! note "literal"\nends here`` in prose.\n', "admonition")

    def test_violation_after_nested_fence_is_still_found(self):
        self.assertFlags('````md\n```\n````\n\n!!! note "Real"\n    Body.\n', "admonition")
        self.assertFlags('````\n    ````\n````\n\n!!! note "Real"\n    Body.\n', "admonition")


class GithubAlertsTest(unittest.TestCase):
    def render(self, text):
        return markdown.markdown(
            text, extensions=["pymdownx.superfences", "md_in_html", GithubAlertsExtension()]
        )

    def test_converts_alert_to_admonition(self):
        html = self.render("> [!WARNING]\n> **Body** line.")
        self.assertIn('<div class="admonition warning">', html)
        self.assertIn('<p class="admonition-title">Warning</p>', html)
        self.assertIn("<strong>Body</strong> line.", html)

    def test_consumes_indented_body_markers(self):
        html = self.render("> [!NOTE]\n  > Body")
        self.assertIn('<div class="admonition note">', html)
        self.assertIn("<p>Body</p>", html)

    def test_leaves_alerts_inside_fences_untouched(self):
        for text in [
            "```md\n> [!NOTE]\n```",
            "```md\n> ```\n> [!NOTE]\n> literal\n```",
            "> ```markdown\n> [!NOTE]\n> ```",
        ]:
            with self.subTest(text=text):
                self.assertNotIn("admonition", self.render(text))

    def test_plain_blockquote_is_unchanged(self):
        self.assertIn("<blockquote>", self.render("> Just a quote [!NOTE]"))


if __name__ == "__main__":
    unittest.main()
