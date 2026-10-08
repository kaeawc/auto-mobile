# Managed Macs and CI runners

On iOS simulators, `networkCondition` relies on a macOS network-filter system extension.
Out of the box, macOS asks a person to approve it twice: once for the system extension
and once for the content filter. On Macs that nobody watches, such as CI runners, EC2 Mac
hosts, or a team's managed machines, you can remove both prompts with one MDM
configuration profile that works for every AutoMobile release.

**Download:** [automobile-network-filter.mobileconfig](../assets/mdm/automobile-network-filter.mobileconfig)

> [!IMPORTANT]
> Deliver this profile through MDM. If someone opens the file or installs it with
> System Settings, it does not pre-approve system extensions. macOS accepts the
> system extension policy only from an MDM, so the approval prompts still appear.

## What the profile contains

The profile has two payloads. Both identify AutoMobile by its Apple Team ID `CEZH89E7MT`
and the bundle identifiers, never by a version or code hash.

| Payload                             | Setting                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `com.apple.system-extension-policy` | Allows `dev.jasonpearson.automobile.networkfilter.provider` from team `CEZH89E7MT`, with the extension type `NetworkExtension`. |
| `com.apple.webcontent-filter`       | A `Plugin` filter for the app `dev.jasonpearson.automobile.networkfilter`, with socket filtering on and packet filtering off.   |

The content filter accepts the provider by this designated requirement:

```text
anchor apple generic and identifier "dev.jasonpearson.automobile.networkfilter.provider" and certificate leaf[subject.OU] = "CEZH89E7MT"
```

The requirement names only the Apple anchor, the bundle identifier, and the team. It
still matches after an AutoMobile upgrade or a Developer ID certificate renewal, so you
upload the profile once. The payload identifiers and UUIDs are fixed: if the profile ever
changes, uploading the new file replaces the installed one instead of adding a second
copy. Every release build checks that the signed app still satisfies this requirement and
fails if it doesn't.

## Upload it to your MDM

The exact menus differ between products such as Jamf Pro, Kandji, and Mosyle, but the
steps are the same:

1. Download `automobile-network-filter.mobileconfig` from the link above.
2. In your MDM, add a custom configuration profile and upload the file as-is. Don't
   rebuild it from the MDM's own system extension or content filter forms unless you copy
   every value exactly, including the designated requirement.
3. Scope it to the device, not a user, and assign it to the Macs or the CI runner group
   that run iOS simulators.
4. Wait for the Macs to check in, then confirm the profile is installed:

   ```bash
   sudo profiles show -type configuration | grep -A2 "dev.jasonpearson.automobile.mdm.network-filter"
   ```

5. Install the network-filter app in `/Applications` and run its `activate` command, as
   described in the [network filter README](https://github.com/kaeawc/auto-mobile/blob/main/ios/network-filter/README.md).
   The profile removes the approval prompts. It doesn't install the app.

To check that a Mac is enrolled in an MDM, run:

```bash
profiles status -type enrollment
```

macOS accepts system extension policies only when this reports `MDM enrollment: Yes
(User Approved)` or `Enrolled via DEP: Yes`.

## EC2 Mac instances

- Enroll each EC2 Mac instance in your MDM, the same way you would enroll a physical Mac,
  and make sure the enrollment counts as user approved. Install the profile through that
  MDM.
- Without MDM, approvals only exist on the instance where someone clicked them. A new
  instance, a fresh AMI, or a dedicated host that AWS scrubbed between instances starts
  without them, and the prompts come back. With MDM, the profile is installed again when
  the instance enrolls.
- Enroll before you run `activate` for the first time. An extension that is already
  waiting for approval may need `activate` to run again once the profile is installed.

## Verify

After the profile is installed and `activate` has run:

1. The system extension is active and enabled:

   ```bash
   systemextensionsctl list
   ```

   The `dev.jasonpearson.automobile.networkfilter.provider` row shows `[activated enabled]`.

2. The controller reports `ready` without anyone clicking anything:

   ```bash
   "/Applications/AutoMobile Network Identity Probe.app/Contents/MacOS/network-filter-controller" status
   ```

3. Once the iOS simulator `networkCondition` backend ships (#10588), `getDeviceState`
   reports its `networkCondition` backend as ready on that Mac.

If the controller still reports `approval_required`, check that `profiles status -type
enrollment` shows an MDM enrollment and that the profile appears in `profiles show`. A
profile installed by hand doesn't count.

## For contributors

`scripts/network-filter/generate-mdm-profile.ts` generates the profile from the Team ID in
`src/constants/appleTeam.ts` and the bundle identifiers in `ios/network-filter/Packaging/`.
Tests check that the committed file matches the generator byte for byte and that
`plutil -lint` accepts it. After changing an identifier, regenerate it:

```bash
bun scripts/network-filter/generate-mdm-profile.ts
```

The release workflow runs `scripts/ci/verify-network-filter-requirement.sh` on the signed
app. It reads the requirement from the committed profile, so a release that would stop
matching the profile fails before it ships.
