# Listing device images

`listDeviceImages` lists the configured emulators (Android) or simulators (iOS,
tvOS, visionOS) on this host, booted or not.

| Parameter     | Values                               | Default   |
| ------------- | ------------------------------------ | --------- |
| `platform`    | `android`, `ios`, `tvos`, `visionos` | required  |
| `detail`      | `compact`, `full`                    | `compact` |
| `sessionUuid` | session used for admission           | none      |

## Result

- `images`: one entry per image, with `identity.stableId`, `name`, `platform`,
  `formFactor` and `runtime.lifecycle`.
- `count`: the total number of images.
- `configuredInventory`: whether discovery completed for the platform. Check
  `configuredInventory.complete` before treating a short list as the whole
  inventory.

### Compact (default)

Facts shared by many images are returned once:

- `capabilityProfiles`: capability inventories keyed by name. An image's
  `capabilityProfile` names its entry.
- `host.capabilities`: host-scoped capabilities, such as the host's default audio
  input and output. They apply to every image that has a `capabilityProfile`.
- Fields whose value would be `null` are left out, as are `display` and `image`
  when every member is `null`.

An image's full capability list is its profile's `capabilities` plus
`host.capabilities`.

### Full

`detail: "full"` returns each image with its own `capabilityInventory` (host
capabilities included) and every field, `null` values included. Use it only if
you need that per-image shape; it is several times larger.

## Large results

A result over 64 KiB is written to a tool-output file. The inline result then
has `artifact` (with `resourceUri`) and a `resource_link` content block, and
keeps `count`, `platform`, `configuredInventory` and `host`. `capabilityProfiles`
holds the profiles that the inline images name, so every inline
`capabilityProfile` resolves. It adds:

- `truncated`: `true` when `images` holds fewer than `count` entries.
- `imagesReturned`: the number of entries inline in `images`.

When `truncated` is `true`, read `artifact.resourceUri` (or the `resource_link`)
for the full list. A result without `truncated` has every image inline, and
`count` equals the length of `images`.
