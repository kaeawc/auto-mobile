# Accessibility in UI tests

Use semantic labels and identifiers in plans, then verify the same elements in
`observe` output before interacting with them. Check text alternatives, content
descriptions or accessibility labels, focus order, contrast, and tap-target size
as part of the assertions. Support for toggling services varies by device type and
OS version.

## Turn on a screen reader

Enable the default-off `accessibility` tool for the current MCP connection:

```json
{
  "name": "setToolEnabled",
  "arguments": { "toolName": "accessibility", "enabled": true }
}
```

Call `accessibility` with `talkback: true` on Android or `voiceover: true` on iOS,
run the flow, and disable it afterward.

## System prompts after enabling TalkBack

Enabling TalkBack may leave a system runtime permission prompt covering the
screen, sometimes a few seconds after the setting changes. The call waits up to 4
seconds for such a prompt. It ends sooner once the screen is stable and TalkBack
has no runtime permission left to request.

When it detects a prompt, the result reports it in `warning` and in
`blockingPrompt` (`kind`, `package`, `activity`):

| `kind`               | Prompt                                            |
| -------------------- | ------------------------------------------------- |
| `runtime-permission` | A permission prompt, from TalkBack or another app |
| `system-dialog`      | A SystemUI or framework dialog activity           |

AutoMobile does not dismiss the prompt. Use `observe` to inspect it, then `tapOn`
to answer the allow or deny button or dismiss the dialog. You can also set a
`systemAlerts` policy to answer permission prompts around each interaction.

On Android, a system window (permission prompt, SystemUI or framework dialog) can
hold focus over the app. When `sendKeys` then cannot focus its field, the failure
reports that window in `blockingPrompt` (`kind`, `package`). Dismiss the window
rather than scrolling.

## Set screen reader focus

The default-off debug tool `accessibilityFocus` sets TalkBack focus on Android
and VoiceOver focus on iOS. On iOS it requires VoiceOver enabled and the
AutoMobile in-app SDK in the foreground app, and cannot read focus back. Only Android supports clearing
focus.

## Taps with VoiceOver

With VoiceOver on, iOS can hold or swallow a tap. When a `tapOn`, `tapAny` or
`tapAt` tap times out with VoiceOver on, the error names VoiceOver and says the
outcome is indeterminate. The tap may or may not have run, so AutoMobile does not
retry it.

Call `observe` to see whether the tap took effect. If it did not, call
`accessibility` with `voiceover: false`, then retry.

## Taps with TalkBack

With TalkBack on, `tapOn` activates the nearest clickable owner of the matched
element. It uses an accessibility action when the owner has a stable id.
Otherwise it moves TalkBack focus and double taps at the owner's center.

Success does not prove the intended control responded. The result's `warnings`
flag two cases:

- The activated element's bounds do not contain the matched element's bounds, so
  a different control may have responded. Not reported for `action: "focus"`.
- The tap or double tap reported success but the screen did not change. Moving
  TalkBack focus counts as a change. Not reported for `action: "focus"` once the
  field's focus is verified.

Each warning names the elements and gives the matched element's center. Call
`observe`; if the intended control did not respond, call `tapAt` at that center.
