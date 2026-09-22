#!/usr/bin/env bats
#
# Tests for scripts/validate_docs_github_markdown.sh

SCRIPT="scripts/validate_docs_github_markdown.sh"

setup() {
  DOCS_DIR="$(mktemp -d)"
  export DOCS_DIR
}

teardown() {
  rm -rf "$DOCS_DIR"
}

@test "passes on the real docs/ tree" {
  DOCS_DIR="docs" run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"GitHub-compatible"* ]]
}

@test "passes on GitHub-compatible constructs" {
  cat >"$DOCS_DIR/ok.md" <<'EOF'
## Android

> [!NOTE]
> Body.

<details markdown="1">
<summary>More</summary>

Text.

</details>

<div class="example-demo" markdown>

![demo](a.gif)

</div>
EOF
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
}

@test "ignores MkDocs syntax inside fenced code and inline code" {
  cat >"$DOCS_DIR/code.md" <<'EOF'
Use `=== "Tab"` or `{ .class }` only in examples.

~~~markdown
=== "Tab"
!!! note
<style></style>
~~~
EOF
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
}

@test "flags each MkDocs-only construct with file and line" {
  mkdir -p "$DOCS_DIR/nested"
  cat >"$DOCS_DIR/nested/bad.md" <<'EOF'
=== "Android"
    === "iOS"
!!! note "Title"
??? example "Title"
???+ note "Open"
<style>
<script>
![demo](a.gif){ .example-demo }
--8<-- "snippet.md"
EOF
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"nested/bad.md:1: MkDocs tab"* ]]
  [[ "$output" == *"nested/bad.md:2: MkDocs tab"* ]]
  [[ "$output" == *"nested/bad.md:3: MkDocs admonition"* ]]
  [[ "$output" == *"nested/bad.md:4: MkDocs collapsible"* ]]
  [[ "$output" == *"nested/bad.md:5: MkDocs collapsible"* ]]
  [[ "$output" == *"nested/bad.md:6: inline <style>"* ]]
  [[ "$output" == *"nested/bad.md:7: inline <style>"* ]]
  [[ "$output" == *"nested/bad.md:8: attr_list"* ]]
  [[ "$output" == *"nested/bad.md:9: snippet include"* ]]
}

@test "a shorter fence inside a longer fence does not end the code block" {
  cat >"$DOCS_DIR/nested-fence.md" <<'EOF2'
````markdown
```
=== "Tab"
```
````

!!! note "Real violation"
EOF2
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"nested-fence.md:7: MkDocs admonition"* ]]
  [[ "$output" != *"nested-fence.md:3"* ]]
}

@test "flags key/value and colon-prefixed attr_list forms" {
  cat >"$DOCS_DIR/attrs.md" <<'EOF2'
[Link](https://example.com){ target=_blank }
## Heading {: #custom-id }
EOF2
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"attrs.md:1: attr_list"* ]]
  [[ "$output" == *"attrs.md:2: attr_list"* ]]
}

@test "a four-space-indented fence is an indented code line, not a fence opener" {
  printf '%s\n' '    ```' '' '!!! note "Real violation"' >"$DOCS_DIR/indented.md"
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"indented.md:3: MkDocs admonition"* ]]
}

@test "multi-backtick inline code spans are ignored" {
  printf '%s\n' '``!!! note``' 'Use ``a ` b { .x }`` here.' '```=== "Tab"```' >"$DOCS_DIR/spans.md"
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
}

@test "an unmatched backtick run does not hide a violation" {
  printf '%s\n' '!!! note ``unclosed' >"$DOCS_DIR/unmatched.md"
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"unmatched.md:1: MkDocs admonition"* ]]
}

@test "a fence nested in a list item is measured from the item's content column" {
  printf '%s\n' '- Example:' '' '    ```markdown' '    !!! note "Literal example"' '    ```' '' '1. Step' '' '      ```' '      === "Tab"' '      ```' >"$DOCS_DIR/list.md"
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
}

@test "a list-nested fence still cannot sit four columns past the item content" {
  printf '%s\n' '- Item' '' '      ```' '' '!!! note "Real violation"' >"$DOCS_DIR/list-deep.md"
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"list-deep.md:5: MkDocs admonition"* ]]
}

@test "a backtick opener with a backtick in its info string is not a fence" {
  printf '%s\n' '```foo`bar' '!!! note "Real violation"' >"$DOCS_DIR/info.md"
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"info.md:2: MkDocs admonition"* ]]
}

@test "flags inline attr lists followed by more text" {
  printf '%s\n' '[Link](https://example.com){ target=_blank } trailing prose' '**Bold**{ .x } and more' >"$DOCS_DIR/inline-attrs.md"
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"inline-attrs.md:1: attr_list"* ]]
  [[ "$output" == *"inline-attrs.md:2: attr_list"* ]]
}
