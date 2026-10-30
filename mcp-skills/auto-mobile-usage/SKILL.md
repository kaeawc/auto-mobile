---
name: auto-mobile-usage
description: How to drive Android and iOS devices with AutoMobile MCP tools. Use before acquiring a device, observing a screen, or acting on one, and when a call fails with device_owned_by_other_session, device_service_disabled or capacity_exhausted.
---

# Driving devices with AutoMobile

## 1. Get a session first

- Acquire a device with `getAndroid` or `getApple`. It finds or boots one and returns a `sessionUuid`.
- A connection that acquired a device is bound to it, so later calls route to that session without repeating it. A different connection, or a CLI call, passes `sessionUuid` on every call.
- A device that a session holds takes control calls only from that session (`device_owned_by_other_session` otherwise). Naming someone else's `sessionUuid` never takes the device over.
- `setActiveDevice` and acquisition are the only calls that change which session an untargeted call uses. With several sessions, pass `sessionUuid` or `deviceId` (`ambiguous_session_selector`).
- `session_ownership_lost` and `no_active_device_session` are permanent for that session: acquire a new one.

## 2. Observe before you act

- Call `observe` before the first action and again after each action that can change the screen. Coordinates and Android synthetic `s2-` element ids are valid only for the observation that returned them.
- Act on what `observe` returned: `tapOn` takes a `selector` (`text`, `elementId`, `testTag`), `swipeOn` scrolls the screen or a container (`lookFor` scrolls until an element appears), `tapAt` takes coordinates, `sendKeys` types into the focused field. Do not guess coordinates.
- Ask `observe` for a screenshot only when the hierarchy is not enough; images are the largest part of a result.

## 3. Resources versus tools

- Tools act or run a computation. Resources (`automobile:` URIs) are cheap read-only state: `automobile:tools` lists every tool and whether it is enabled, `automobile:devices/booted` lists booted devices, `automobile:observation/latest` is the latest observation.
- Read a resource instead of calling a tool when you only need state. A sessionless read never takes a held device.
- A tool that is gated off does not appear in `tools/list`. Enable it with `setToolEnabled` or the `enableTools` argument of `getAndroid` and `getApple`.

## 4. Long operations and Tasks

- `executePlan`, `installApp` and `videoRecording` with `action: "stop"` can run as a task when your client declares the Tasks extension. You get a task handle, poll it with `tasks/get`, and cancel with `tasks/cancel`; the work survives a client reconnect.
- Do not wrap short interaction calls (`tapOn`, `sendKeys`, `pressButton`) in tasks. Without Tasks support the same calls simply block until done.

## 5. Typed errors

An error result carries a stable `code`. Read `code` and `retryable` instead of the message text.

| Code                            | Meaning and next step                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capacity_exhausted`            | The platform is at its booted-device limit. Retryable: wait `retryAfterMs`, or shut down a device you hold, then repeat the acquisition. Do not loop faster than `retryAfterMs`.            |
| `device_service_disabled`       | A simulator service the tool needs is switched off. Not retryable until you act: follow `howToEnable` in the error (enable it with `setDeviceResources`) or start the simulator without it. |
| `device_owned_by_other_session` | Another session holds the device. Acquire your own device or pass the right `sessionUuid`.                                                                                                  |
| `plan_execution_in_progress`    | A plan is running on the session. Retry when it finishes; reads stay allowed.                                                                                                               |

Release a device you no longer need so other sessions can use it.
