# Reproducing bugs

Give an agent the app, platform, starting state, steps, and expected versus
actual behavior. It can reproduce the issue, record what happened, and save a
device snapshot for someone else to inspect.

## Bug-report prompt

> Reproduce this bug in the <app-name> <Android|iOS> app:
>
> <bug report>
>
> Report the exact steps, expected and actual results, device and OS version,
> app version, and whether the issue reproduced consistently. Highlight defects
> that will help another person reproduce it, then take a device snapshot.

<div class="doc-switcher" data-doc-switcher="bug-reproduction" data-doc-switcher-default="workflow" role="group" aria-label="Bug reproduction details">
  <button type="button" data-doc-switcher-option="workflow">Workflow</button>
  <button type="button" data-doc-switcher-option="demo">Demo</button>
</div>

<div data-doc-switcher-panel="bug-reproduction" data-doc-switcher-value="workflow" markdown>

## What the agent does

1. Finds the relevant screen and recreates the supplied context.
2. Follows the suspected steps and records the observed result.
3. Highlights the defect or important UI state.
4. Captures a device snapshot when the reproduced state should be shared.

</div>

<div data-doc-switcher-panel="bug-reproduction" data-doc-switcher-value="demo" markdown>

## Bug reproduction

![An AI agent reproducing a sample counter bug and highlighting the issue](../img/bug-repro.gif)

</div>
