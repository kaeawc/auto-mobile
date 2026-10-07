# Android touch-node and input captures

Every `.txt` file here is raw device output, copied verbatim (the leading `#`
lines are the capture's own header). None is hand-written or edited.

Taken 2026-10-06 on `am-api36-ga-arm64` emulators. The files are pinned to LF in
`.gitattributes` and excluded from the formatter in `.oxfmtrc.json`.

## emulator-5600 (phone, 1080x2400)

- Input node: `/dev/input/event1` (`virtio_input_multi_touch_1`).
- `getevent-p-touch-node-emulator-5600.txt` is `getevent -p` and `getevent -lp`
  for the node: ABS_MT_POSITION_X/Y both `min 0, max 32767`; the key list is
  `BTN_TOOL_RUBBER BTN_STYLUS`, so there is no `BTN_TOUCH`. The
  `...-landscape-rot90-...` file is the same query while `ROTATION_90`: the range
  does not change with rotation.
- `getevent-lt-{tap,swipe}-{portrait,landscape-rot90}-emulator-5600.txt` and the
  same names with `-all-axes` are raw `getevent -lt`. The events were injected
  with `sendevent`, and the kernel reports only axes whose value changed since the
  previous contact. The files without `all-axes` therefore have no
  ABS_MT_POSITION_X on any event (and no SLOT, PRESSURE or TOUCH_MAJOR); the
  `all-axes` ones were taken with every value changed, except that the portrait
  `-all-axes` tap still has no ABS_MT_POSITION_Y (its Y repeated the previous
  contact's). Contacts start and end on ABS_MT_TRACKING_ID; no EV_KEY event appears.

## emulator-5602 (foldable)

- `getevent-p-all-nodes-{opened,closed}-emulator-5602.txt` is `getevent -p` for
  every node, opened (2076x2152) and closed (1080x2364). They differ only in the
  header line.
- `dumpsys-input-devices-{opened,closed}-emulator-5602.txt` is the Input Devices
  section of `dumpsys input` in the same two postures: `virtio_input_multi_touch_1`
  is a DIRECT touch mapper in both, and `virtio_input_multi_touch_7` is DISABLED
  opened but DIRECT closed.
