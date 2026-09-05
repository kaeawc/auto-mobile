# Agent Examples

<div class="prompt-form" markdown>
  <label for="am-app-name">Your app name</label>
  <input id="am-app-name" data-prompt-var="app" type="text" placeholder="e.g. Acme Shopping" autocomplete="off" spellcheck="false">
</div>

## Example prompts

=== "Take a tour"

    <div class="copyable-prompt" markdown>

    > Open my <code class="prompt-var" data-prompt-var="app" data-default="your app">your app</code> app and explore its main
    > features. Visit each primary tab or section, and give me a short map of the
    > key user flows you find. Call out any screen you couldn't reach and why.

    </div>

    ![An AI agent exploring Google Maps — launching the app, searching for a city, and zooming to a neighborhood](../img/google-maps.gif){ .example-demo }

=== "Search for something"

    <div class="copyable-prompt" markdown>

    > In <code class="prompt-var" data-prompt-var="app" data-default="your app">your app</code>, use search to find
    > <code class="prompt-var--edit" contenteditable="true">what to search for</code> and
    > open the first result. Tell me how many taps it took, and whether anything
    > about the search or results was confusing.

    </div>

    ![An AI agent searching YouTube and opening a result](../img/youtube-search.gif){ .example-demo }

=== "Walk onboarding"

    <div class="copyable-prompt" markdown>

    > Go through <code class="prompt-var" data-prompt-var="app" data-default="your app">your app</code>'s onboarding as a brand-new
    > user, from first launch to the main screen. Report each step, any dead ends
    > or confusing copy, and controls that were hard to find or tap.

    </div>

=== "Fill out a form"

    <div class="copyable-prompt" markdown>

    > In <code class="prompt-var" data-prompt-var="app" data-default="your app">your app</code>, open
    > <code class="prompt-var--edit" contenteditable="true">a screen or feature</code> and
    > fill in the form — enter realistic text, pick a date one week from today,
    > and set any toggles or options. Submit it and confirm the result, flagging
    > fields that were awkward to use.

    </div>

    ![An AI agent opening the Clock app, selecting the alarm tab, and creating an alarm](../img/clock-app.gif){ .example-demo }

=== "Scroll and find"

    <div class="copyable-prompt" markdown>

    > Open <code class="prompt-var--edit" contenteditable="true">a list or feed</code> in
    > <code class="prompt-var" data-prompt-var="app" data-default="your app">your app</code>, scroll until you find
    > <code class="prompt-var--edit" contenteditable="true">an item</code>, then open its
    > detail screen. Report whether the list scrolled smoothly and if anything
    > was hard to reach.

    </div>

    ![An AI agent scrolling a list and measuring scroll and transition smoothness](../img/scroll-transition-perf.gif){ .example-demo }

=== "Reproduce a bug"

    <div class="copyable-prompt" markdown>

    > Reproduce this bug in my <code class="prompt-var" data-prompt-var="app" data-default="your app">your app</code> app:
    >
    > <code class="prompt-var--edit" contenteditable="true">paste the bug report here</code>
    >
    > Report the exact steps, expected and actual results, device and OS version,
    > app version, and whether it reproduced consistently. Highlight the defect,
    > then take a device snapshot so someone else can inspect the state.

    </div>

    ![An AI agent reproducing a sample counter bug and highlighting the issue](../img/bug-repro.gif){ .example-demo }

=== "Measure performance"

    <div class="copyable-prompt" markdown>

    > Launch my <code class="prompt-var" data-prompt-var="app" data-default="your app">your app</code> app five times, measure cold
    > and warm startup, and report time to first frame, time to interactive, and
    > any outliers. Then open a long list, scroll it a few times, and report FPS,
    > dropped frames, and visible jank.

    </div>

    ![An AI agent measuring app startup through a deep link](../img/deeplink-startup.gif){ .example-demo }

=== "Check accessibility"

    <div class="copyable-prompt" markdown>

    > Explore the current screen in <code class="prompt-var" data-prompt-var="app" data-default="your app">your app</code> and point
    > out interactive elements that are difficult to use — small tap targets, low
    > contrast, missing labels, or unclear controls. Suggest what to fix first.

    </div>
