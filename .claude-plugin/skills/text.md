---
description: Text input, keyboard control, and clipboard operations
allowed-tools: mcp__auto-mobile__sendKeys, mcp__auto-mobile__selectAllText, mcp__auto-mobile__keyboard, mcp__auto-mobile__clipboard
---

Handle text input, keyboard interactions, and clipboard operations.

## Text Input

Type text into the focused field:

```
sendKeys with commands: [{ action: "type", text: "Hello, world!", operation: "insert" }]
```

The field must be focused first (use `tapOn` with action "focus").

## Clear Text

Clear the current input field:

```
sendKeys with commands: [{ action: "clear" }]
```

Removes all text from the focused field.

## Select All Text

Select all text in the focused field:

```
selectAllText
```

Useful for replacing existing text:

```
sendKeys with commands: [{ action: "type", text: "new text", operation: "replace" }]
```

## Keyboard Control

Control the soft keyboard:

```
keyboard with action: "open"    # Show keyboard
keyboard with action: "close"   # Hide keyboard
keyboard with action: "detect"  # Check if visible
```

## IME Actions

Trigger keyboard action buttons:

```
sendKeys with commands: [{ action: "key", key: "done" }]    # Submit/complete
sendKeys with commands: [{ action: "key", key: "next" }]    # Move to next field
sendKeys with commands: [{ action: "key", key: "search" }]  # Trigger search
sendKeys with commands: [{ action: "key", key: "send" }]    # Send message
sendKeys with commands: [{ action: "key", key: "go" }]      # Navigate/submit
```

## Clipboard

Manage clipboard content:

```
clipboard with action: "copy", text: "Text to copy"
clipboard with action: "paste"    # Paste into focused field
clipboard with action: "get"      # Read clipboard content
clipboard with action: "clear"    # Clear clipboard
```

## Common Workflows

**Fill a text field:**

```
tapOn (field) → sendKeys type "insert" → sendKeys key "next"
```

**Replace existing text:**

```
tapOn (field) → sendKeys type "replace" (new text)
```

**Copy text between fields:**

```
tapOn (source) → selectAllText → clipboard "copy"
tapOn (target) → clipboard "paste"
```

**Submit a form:**

```
sendKeys type "insert" (last field) → sendKeys key "done"
```

## Tips

- Always focus a field before typing (use `tapOn` or `tapOn` with action "focus")
- Use `sendKeys` with a `next` key command to move through form fields efficiently
- Check `keyboardVisible` in observation before text operations
- Use `sendKeys` with `operation: "replace"` to replace text
