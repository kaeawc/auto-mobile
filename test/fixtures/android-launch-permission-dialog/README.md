# Android launch behind a permission dialog

`contacts-first-launch-api37.json` is the `launchApp` result captured by the MCP
dogfood loop (#17465) on AVD `amverify-api37b` (API 37): the first launch of
`com.google.android.contacts` landed behind the notification-permission dialog.
The `activeWindow`, `notificationPermissionDetected`, `observedAppId` source
and the two `grant_singleton`/`grant_dialog` rows at `[28,824,1052,1645]` are as
captured. The two grant buttons are reconstructed from the platform's
`permission_allow_button`/`permission_deny_button` ids and labels, since the
captured skeleton excerpt did not include them.
