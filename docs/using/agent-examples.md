# Agent Examples

<div class="prompt-form" markdown>
  <label for="am-app-name">Your app name</label>
  <input id="am-app-name" data-prompt-var="app" type="text" placeholder="e.g. Acme Shopping" autocomplete="off" spellcheck="false">
</div>

=== "Take a tour"

    === "Android"

        <div class="copyable-prompt" markdown>

        > Open my <code class="prompt-var" data-prompt-var="app" data-default="your app">your app</code> Android app and explore its
        > main features. Visit each primary tab or section, and give me a short map
        > of the key user flows you find. Call out any screen you couldn't reach.

        </div>

        ![An AI agent exploring Google Maps on Android — launching the app, searching for a city, and zooming to a neighborhood](../img/google-maps.gif){ .example-demo }

    === "iOS"

        <div class="copyable-prompt" markdown>

        > Open my <code class="prompt-var" data-prompt-var="app" data-default="your app">your app</code> iOS app and explore its main
        > features. Visit each primary tab or section, and give me a short map of
        > the key user flows you find. Call out any screen you couldn't reach.

        </div>

=== "Search for something"

    === "Android"

        <div class="copyable-prompt" markdown>

        > In my <code class="prompt-var" data-prompt-var="app" data-default="your app">your app</code> Android app, use search to find
        > <code class="prompt-var--edit" contenteditable="true">what to search for</code> and
        > open the first result. Tell me how many taps it took, and whether anything
        > about the search or results was confusing.

        </div>

        ![An AI agent searching YouTube on Android and opening a result](../img/youtube-search.gif){ .example-demo }

    === "iOS"

        <div class="copyable-prompt" markdown>

        > In my <code class="prompt-var" data-prompt-var="app" data-default="your app">your app</code> iOS app, use search to find
        > <code class="prompt-var--edit" contenteditable="true">what to search for</code> and
        > open the first result. Tell me how many taps it took, and whether anything
        > about the search or results was confusing.

        </div>

=== "Walk onboarding"

    === "Android"

        <div class="copyable-prompt" markdown>

        > Go through my <code class="prompt-var" data-prompt-var="app" data-default="your app">your app</code> Android app's onboarding as
        > a brand-new user, from first launch to the main screen. Report each step,
        > any dead ends or confusing copy, and controls that were hard to tap.

        </div>

    === "iOS"

        <div class="copyable-prompt" markdown>

        > Go through my <code class="prompt-var" data-prompt-var="app" data-default="your app">your app</code> iOS app's onboarding as a
        > brand-new user, from first launch to the main screen. Report each step,
        > any dead ends or confusing copy, and controls that were hard to tap.

        </div>

=== "Fill out a form"

    === "Android"

        <div class="copyable-prompt" markdown>

        > In my <code class="prompt-var" data-prompt-var="app" data-default="your app">your app</code> Android app, open
        > <code class="prompt-var--edit" contenteditable="true">a screen or feature</code> and
        > fill in the form — enter realistic text, pick a date one week from today,
        > and set any toggles or options. Submit it and confirm the result, flagging
        > fields that were awkward to use.

        </div>

        ![An AI agent opening the Clock app on Android, selecting the alarm tab, and creating an alarm](../img/clock-app.gif){ .example-demo }

    === "iOS"

        <div class="copyable-prompt" markdown>

        > In my <code class="prompt-var" data-prompt-var="app" data-default="your app">your app</code> iOS app, open
        > <code class="prompt-var--edit" contenteditable="true">a screen or feature</code> and
        > fill in the form — enter realistic text, pick a date one week from today,
        > and set any toggles or options. Submit it and confirm the result, flagging
        > fields that were awkward to use.

        </div>

=== "Scroll and find"

    === "Android"

        <div class="copyable-prompt" markdown>

        > Open <code class="prompt-var--edit" contenteditable="true">a list or feed</code> in my
        > <code class="prompt-var" data-prompt-var="app" data-default="your app">your app</code> Android app, scroll until you find
        > <code class="prompt-var--edit" contenteditable="true">an item</code>, then open its
        > detail screen. Report whether the list scrolled smoothly and if anything
        > was hard to reach.

        </div>

        ![An AI agent scrolling a list on Android and measuring scroll and transition smoothness](../img/scroll-transition-perf.gif){ .example-demo }

    === "iOS"

        <div class="copyable-prompt" markdown>

        > Open <code class="prompt-var--edit" contenteditable="true">a list or feed</code> in my
        > <code class="prompt-var" data-prompt-var="app" data-default="your app">your app</code> iOS app, scroll until you find
        > <code class="prompt-var--edit" contenteditable="true">an item</code>, then open its
        > detail screen. Report whether the list scrolled smoothly and if anything
        > was hard to reach.

        </div>

=== "Reproduce a bug"

    === "Android"

        <div class="copyable-prompt" markdown>

        > Reproduce this bug in my <code class="prompt-var" data-prompt-var="app" data-default="your app">your app</code> Android app:
        >
        > <code class="prompt-var--edit" contenteditable="true">paste the bug report here</code>
        >
        > Report the exact steps, expected and actual results, device and OS version,
        > app version, and whether it reproduced consistently. Highlight the defect,
        > then take a device snapshot so someone else can inspect the state.

        </div>

        ![An AI agent reproducing a sample counter bug on Android and highlighting the issue](../img/bug-repro.gif){ .example-demo }

    === "iOS"

        <div class="copyable-prompt" markdown>

        > Reproduce this bug in my <code class="prompt-var" data-prompt-var="app" data-default="your app">your app</code> iOS app:
        >
        > <code class="prompt-var--edit" contenteditable="true">paste the bug report here</code>
        >
        > Report the exact steps, expected and actual results, device and OS version,
        > app version, and whether it reproduced consistently. Highlight the defect,
        > then take a device snapshot so someone else can inspect the state.

        </div>

=== "Measure performance"

    === "Android"

        <div class="copyable-prompt" markdown>

        > Launch my <code class="prompt-var" data-prompt-var="app" data-default="your app">your app</code> Android app five times, measure
        > cold and warm startup, and report time to first frame, time to
        > interactive, and any outliers. Then open a long list, scroll it a few
        > times, and report FPS, dropped frames, and visible jank.

        </div>

        ![An AI agent measuring Android app startup through a deep link](../img/deeplink-startup.gif){ .example-demo }

    === "iOS"

        <div class="copyable-prompt" markdown>

        > Launch my <code class="prompt-var" data-prompt-var="app" data-default="your app">your app</code> iOS app five times, measure cold
        > and warm startup, and report time to first frame, time to interactive,
        > and any outliers. Then open a long list, scroll it a few times, and report
        > FPS, dropped frames, and visible jank.

        </div>

=== "Check accessibility"

    === "Android"

        <div class="copyable-prompt" markdown>

        > Explore the current screen in my <code class="prompt-var" data-prompt-var="app" data-default="your app">your app</code> Android app
        > and point out interactive elements that are difficult to use — small tap
        > targets, low contrast, missing labels, or unclear controls. Suggest what
        > to fix first.

        </div>

    === "iOS"

        <div class="copyable-prompt" markdown>

        > Explore the current screen in my <code class="prompt-var" data-prompt-var="app" data-default="your app">your app</code> iOS app and
        > point out interactive elements that are difficult to use — small tap
        > targets, low contrast, missing labels, or unclear controls. Suggest what
        > to fix first.

        </div>
