# locationd clients.plist captures

`clients.plist` from an iPhone 17 Pro simulator, iOS 27.2 (Xcode 27.2), converted with
`plutil -convert xml1`, the form the reader parses. The home directory in the app paths is
rewritten to `/Users/dev`; nothing else is edited. Each file is the state after one
`simctl privacy` call on `dev.jasonpearson.automobile.Playground` (#19370):

| File                                  | Call                    | `Authorization` |
| ------------------------------------- | ----------------------- | --------------- |
| `clients-granted-location.xml`        | `grant location`        | 2               |
| `clients-revoked-location.xml`        | `revoke location`       | 1               |
| `clients-granted-location-always.xml` | `grant location-always` | 4               |
| `clients-reset-location.xml`          | `reset location`        | none            |
