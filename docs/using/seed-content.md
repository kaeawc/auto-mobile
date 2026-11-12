# Seed Android system content

`seedContent` prepares contacts, calendar events, call history, and SMS inbox rows for app testing. Enable the tool before use. Select an Android device with the usual `deviceId`, `platform`, or `sessionUuid` parameters; iOS is unsupported.

```json
{
  "namespace": "invite_demo",
  "reset": true,
  "contacts": [
    { "name": "Ada Lovelace", "phones": ["+15555550100"], "emails": ["ada@example.org"] }
  ],
  "calendarEvents": [
    {
      "title": "Demo",
      "start": "2026-11-12T10:00:00Z",
      "end": "2026-11-12T11:00:00Z",
      "location": "Room A",
      "calendar": "Work"
    }
  ],
  "callLog": [
    {
      "number": "+15555550100",
      "type": "incoming",
      "date": "2026-11-11T10:00:00Z",
      "durationSec": 30
    }
  ],
  "smsInbox": [
    {
      "address": "+15555550100",
      "body": "Your code is 123456",
      "date": "2026-11-11T10:00:00Z",
      "read": false
    }
  ]
}
```

`namespace` is required and matches `^[A-Za-z0-9_-]{1,32}$`. Rows are tagged `automobile.<namespace>`. With `reset: true`, supplied arrays select the kinds to remove before inserting; an empty array removes that kind without inserting. With no arrays, reset removes all four kinds for the namespace and then removes its shared account. Kind-specific resets keep the account so contacts and calendar events in other kinds survive. Other namespaces and untagged rows are preserved. Without reset, repeated calls append rows. Data persists until explicitly reset; session release does not promise namespace deletion.

Dates require ISO 8601 timestamps with a timezone. Event `end` must follow `start`. For `allDay: true`, both must be UTC midnight and `end` is exclusive. The default calendar name is `automobile-<namespace>`. Call types are `incoming`, `outgoing`, and `missed`; duration defaults to zero seconds. SMS `read` defaults to false. Contact phone numbers use the mobile type and emails the home type. Contact names, phone numbers, email addresses, and call-log numbers cannot contain colons because Android's binding syntax rejects them.

Each contact may include `photoPath`, a host path to a PNG or JPEG (`.png`, `.jpg`, or `.jpeg`), up to 512 KB (524288 bytes). Relative paths resolve from the tool host's launch directory. Missing or unreadable files, unsupported extensions, invalid image signatures, and oversized files fail before device writes or resets. Photo writes require a current debug seeder APK and Contacts permissions; staging or photo read-back errors report failure and may leave partial contacts, so correct the image or APK and retry with `reset: true`. Temporary photo files are deleted after each attempt and on contact reset; resetting contacts also removes their stored photos. Counts include contacts, with no separate photo count.

The result contains `namespace`, `inserted`, and `removed`. Each count object has `contacts`, `calendarEvents`, `callLog`, and `smsInbox`; contacts count raw contact records and calendar removals count events. Insert counts are returned only after provider read-back confirms the rows; missing rows cause an actionable error.

Call history needs no helper APK. Contacts, calendar, and SMS need the debug content seeder APK; the tool installs it when missing, reinstalls an older installed seeder that does not request the permissions it needs, and grants its SMS role and calendar/SMS read permissions. This changes the default SMS application to the seeder. Use a test device and restore your preferred SMS app afterward. If the APK is unavailable, follow the build command in the error or configure `AUTOMOBILE_CONTENT_SEEDER_APK_PATH` to a built debug APK. Contacts use a registered namespace account to keep them from being purged when accounts change. An incompatible installed APK must be rebuilt and reinstalled.

Provider or permission failures stop the call with an actionable error. Earlier writes can remain: fix the reported cause and retry with reset for the same namespace and kinds. A mixed request checks helper availability before modifying content. Large shell batches can take time; keep fixture sets small.
