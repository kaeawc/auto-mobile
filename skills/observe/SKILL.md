---
name: observe
description: Use this skill to inspect the current state of a connected mobile device through the AutoMobile observe capability and summarize the active app, visible UI, and any obvious interaction targets.
---

# Observe Device

Use the AutoMobile observation tooling to inspect the current device state.

## Workflow

1. Call the `observe` capability for the active device.
2. Report the active app or activity, the most relevant visible UI elements, and the observation timestamp.
3. If the hierarchy is noisy, summarize only the controls that matter to the user’s goal.
4. When follow-up automation is likely, call out obvious next interaction targets such as buttons, fields, tabs, or permission prompts.

## Output Structure

- Active app and activity
- Key visible UI elements
- `updatedAt` timestamp
- Short note on likely next actions when useful
