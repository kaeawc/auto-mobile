# Bug reproduction

The AutoMobile Playground app is open on its Bug Reproduction Demo screen.

Task:

1. Tap **Add Item** twice. Confirm the status card shows the expected and displayed counts are
   both 2.
2. Turn on the **Enable Bug** switch.
3. Tap **Add Item** once more.
4. Read the status card again.

Rules:

- Do not tap **Reset**, and do not use any button in the Error Simulation section.
- Read state from the device UI; do not guess it.

Finish your reply with exactly these three lines, filled in from what the screen shows:

```
EXPECTED_COUNT: <number>
DISPLAYED_COUNT: <number>
STATUS: <status text after "Status: ">
```
