# UX Exploration

Ask an agent what to explore instead of prescribing every tap. AutoMobile finds
or starts a suitable device, launches the app, observes each screen, and
iterates as it navigates.

## Example prompts

> Open my <app-name> <Android|iOS> app and explore its main features. Identify
> the key user flows.

> Use search in <app-name> to find <search result>.

> Explore onboarding in <app-name> and report confusing steps, dead ends, and
> controls that are difficult to use.

> Are there interactive elements on the current screen that are difficult to
> use?

> Use <feature-x> and choose a date one week in the future.

State the outcome you want. Mention a required route—such as a deep link,
search, or scrolling—when the route itself matters.

<div class="doc-switcher" data-doc-switcher="ux-exploration" data-doc-switcher-default="maps" role="group" aria-label="UX exploration demo">
  <button type="button" data-doc-switcher-option="maps">Google Maps</button>
  <button type="button" data-doc-switcher-option="clock">Clock alarm</button>
  <button type="button" data-doc-switcher-option="camera">Camera gallery</button>
</div>

<div data-doc-switcher-panel="ux-exploration" data-doc-switcher-value="maps" markdown>

## Google Maps exploration

![An AI agent exploring Google Maps, searching for locations, and using map controls](../img/google-maps.gif)

</div>

<div data-doc-switcher-panel="ux-exploration" data-doc-switcher-value="clock" markdown>

## Clock app alarm

![An AI agent opening the Clock app, selecting the alarm tab, and creating an alarm](../img/clock-app.gif)

</div>

<div data-doc-switcher-panel="ux-exploration" data-doc-switcher-value="camera" markdown>

## Camera gallery

![An AI agent opening Camera, taking a photo, and viewing it in Gallery](../img/camera-gallery.gif)

</div>
