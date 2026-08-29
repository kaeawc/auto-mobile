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

<details open markdown>
<summary>Workflow</summary>

## What the agent does

1. Finds the relevant screen and recreates the supplied context.
2. Follows the suspected steps and records the observed result.
3. Highlights the defect or important UI state.
4. Captures a device snapshot when the reproduced state should be shared.

</details>

<details markdown>
<summary>Demo</summary>

## Bug reproduction

![An AI agent reproducing a sample counter bug and highlighting the issue](../img/bug-repro.gif)

</details>
