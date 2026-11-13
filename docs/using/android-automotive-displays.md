# Android Automotive secondary displays

An Android Automotive OS emulator can have more than one display, such as a passenger screen. This
page covers driving an app on one of them. For setting up the emulator, see
[Android Automotive OS emulators](android-automotive.md).

## Choosing a display

To drive an app on another display, such as a passenger screen, pass `display` to `observe`, `tapOn`
and `pressButton`. Its value is a panel key, a role or `active`. You can also pin it once for the
session with `setActiveDevice` `display`. An explicit `display`, including `active`, overrides the pin.

## Pressing buttons

For `pressButton`:

- It sends the key to that display and checks that display for the visual change. `display` on
  `pressButton` is Android only.
- `active` means the focused display, not the display you last observed explicitly. The focused
  display is the one the latest `observe` without `display` or a pin read. Before any such read, it
  is the display that holds input focus, or the main display when focus is unknown.
- A `back` that finds a Car App Library template there taps the host's Back control on the same display.
- A `home` that changes nothing because that display already shows its launcher succeeds, as it does
  on the default display.
- System actions (such as `lock` or `quick_settings`) and rotary input still act device-wide;
  `display` only picks the display that AutoMobile checks.
- The session pin does not apply to `lock`, `power`, `power_dialog`, `volume_up`, `volume_down` or
  rotary buttons. They act on the whole device, so they work even when the pinned display is gone.
- Without `display` or a pin, `pressButton` presses on the default display.

## Creating a public display

On an emulator, create the extra display as public: the last field of `-multidisplay` must be `1`, for
example `-multidisplay 1,1280,720,160,1`. Android accessibility does not track a private virtual
display (`0`), so it has no view hierarchy. The `observe` call refuses it with an error that names the display
as private and gives its logical display id. Retrying does not help; recreate the display as public.
