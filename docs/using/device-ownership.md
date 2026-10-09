# Device ownership

A device that a session holds takes calls only from that session. Acquiring a
device with `getAndroid`, `getApple` or `startDevice` creates the session and
returns its `sessionUuid`; the session holds the device until it is released
(idle timeout, lost heartbeat, or an explicit release).

## What is refused

A call that acts on a held device is refused with the typed code
`device_owned_by_other_session` when it:

- carries no `sessionUuid` (a sessionless call, such as a plain `--cli tapOn`),
- names a different session than the holder, or
- is an `input/*` socket frame without the holder's `sessionUuid`
  (see [screen control](screen-control.md)).

A derived `<base>:<label>` session counts as its base session. A device that no
session holds takes calls from anyone.

Tools that only watch stay allowed on any device, whichever session holds it:
`observe`, `identifyInteractions` and `hitTest`.

## Passing the session

- **CLI:** `auto-mobile --cli --session-uuid <uuid> tapOn --selector '{"text":"Submit"}'`.
  Use the `sessionUuid` from the `getAndroid`, `getApple` or `startDevice` result.
  The CLI prints the daemon's message and a hint on stderr and exits 1.
- **MCP:** a connection that acquired a device is bound to it, so its calls route
  to the session without repeating it. A different connection passes `sessionUuid`
  in the call arguments.
- **`scripts/mcp-drive.ts`:** a `getAndroid`/`getApple` step captures the session
  and injects it into later steps; `--session <uuid>` reuses an existing one.
- **Scripts that run `--cli` calls:** keep the acquiring call's `sessionUuid` and
  pass `--session-uuid` on every later call (see
  `scripts/android/navigation-graph-sdk-event-integration.sh`).

## Stopping a held device: `killDevice` and `deleteDevice`

Both stop a running device, so the same rule applies: only the holder (or the
MCP connection that owns an autolocked device) may stop it. A booted device
another session holds is refused with `device_owned_by_other_session` unless the
call passes `force: true`, which overrides the refusal and logs a warning naming
the holder. From the CLI: `auto-mobile --cli killDevice --device '{...}' --force true`.

`force` keeps its older meaning too: for a wedged Android emulator it also skips
the AVD-name comparison. Use it only when the device really should be stopped
out from under its holder. Deleting a stopped image is not affected, since no
session can hold it.

## Ownership is cooperative

Ownership is a guard that protects cooperating clients from each other's
mistakes. It is not a security boundary against other local processes (owner
decision 2026-10-09, #10982). Any local client can list every session UUID
(`daemon/activeSessions` with `includeSessions`), release any session
(`daemon/releaseSession` checks no requester), and edit any session's tool
profile (`ide/setSessionToolEnabled`). That is intended, and there is no token
gating.

## Read and control

Owner decisions 2026-10-09 (#10982):

- Read-only access never requires a session.
- No read counts as activity, not even the owner's own (#10964).
- Anything that changes visible UI, or starts a device-side process, is control.
- Viewer streaming is a read.
- A read on a free device may run full readiness. A read on a held device is
  connect-only.
- Reads run in their own lane (#10969).
- A holder's calls that name only a `deviceId` are credited to the MCP connection
  that owns the held session, and admitted as that session. Other connections
  stay read-only watchers.

## Streams need an observer registration, not a session

`subscribe`, `request_observation`, video and WebRTC viewing still require a
lightweight observer registration (owner decision 2026-10-09, #10982). An
observer registration is not a session: tools need nothing, and streams need only
that registration. A viewer keeps streaming when ownership changes (#8902).

## Recordings

Owner decisions 2026-10-09 (#10982):

- A recording stops and finalizes when its session is released, capped at about
  120 seconds (#10957). This also covers an idle release (#10826).
- A recording with no owner stops when a session acquires the device (#10961).
- Recording artifacts stay fetchable by id (#10958).
- Hiding a desktop or IDE window during a recording does not release the device.

## Retryable acquisition refusals

An acquisition the daemon cannot grant yet is refused with a typed, retryable
code (owner decision 2026-10-09, #10982): `device_cleanup_in_progress` while the
device is still being released (#10960), and `device_owned_by_other_daemon` when
another daemon holds it. Clients may wait and retry.

## Per-session settings

Appearance configuration is per session (owner decision 2026-10-09, #10982).

## Related

- [Environment variables](environment-variables.md#session-heartbeat-timeout):
  session release and idle windows.
- [FAQ](../faq.md#what-if-i-have-more-than-one-device).
