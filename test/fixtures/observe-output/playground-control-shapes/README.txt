Playground "Control Shapes" demo (automobile://playground/demos/controls/shapes), Pixel 7 API 35 emulator,
1080x2400, captured with the AutoMobile daemon built from the #18299 branch.
observe-full.json is observe {"project":"full","includeExtras":true} and observe-skeleton.json is the default
skeleton observe, each taken before any interaction (both Wi-Fi/Bluetooth switches Off, Duplicate A-C Off,
slider 0.5). The files are the complete structuredContent the daemon returned, byte for byte except that
screenshotPath is replaced with <screenshot-path>.
focus-navigate-to-slider.json is focusNavigate {"until":{"resourceId":"readout_less_slider"}} from the top of
the screen (7 steps, no max_steps). focus-navigate-slider-stuck.json is focusNavigate toward a resource id that
is not on screen with focus already on the slider: it ends "stuck" after 2 presses (slider 0.5 -> 0.7).
