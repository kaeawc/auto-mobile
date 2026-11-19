# Apple Watch prototypes

Prototypes do not run on an Apple Watch (#16835, epic #14895). On a watch UDID, `launchApp` refuses
`prototype: true` before any agent preparation, and the iOS [prototype agent](prototype-agent.md)
draws only on a phone. No watch-specific nodes exist in the spec.

To mock up a watch screen, show a watch-sized spec on an iPhone simulator or Android emulator
instead (#14905). Its floating, centred root `box` takes the watch case's size, a corner radius and
a black background. The sizes and an example are in
[Watch-sized mockups](../../../tools.md#watch-sized-mockups). The mockup has no crown, round
display or watchOS system UI.

## Background

- [Defer Apple Watch prototypes](../../../devlog/2026-11-07-watch-prototypes-deferred.md)
