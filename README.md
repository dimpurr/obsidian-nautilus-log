# Nautilus Log for Obsidian

> **Give every minute a job.**

A visual day planner for [Obsidian](https://obsidian.md/). Nautilus Log turns one
note into a living spiral schedule: fixed events stay fixed, flexible tasks flow
into the time that remains, and overload never disappears from view.

**A port of [Nautilus Log for Roam Research](https://github.com/404KSG/roam-nautilus-log)**
— see [Credits](#credits) for the full lineage.

> ⚠️ **Status: early development.** Not yet packaged for distribution. The
> scheduling engine, spiral renderer, capacity header, chart controls, sidebar
> view, and the optional execution layer are implemented.

## What it gives you

- **A plan that fits time.** See Planned demand, Available time, fixed Events,
  remaining capacity, and work that cannot fit today.
- **Flexible scheduling without a black box.** Events keep their time; unfinished
  tasks move forward in written order.
- **A day shaped around you.** Start at any whole hour and continue past midnight
  when the plan belongs to a late or overnight schedule.
- **A useful daily review.** Compare Planned and Actual time without leaving your
  ordinary notes.

Scheduling is deterministic: events claim their ranges first, then whole tasks
fill suitable gaps from the current moment. Tasks that cannot fit appear in
**Today won't fit** instead of being silently dropped.

## Plan format

Unlike the Roam original — where the component reads its child blocks — this port
keeps the plan **as ordinary Markdown below the code block**, because Obsidian
code blocks have siblings rather than children. The block itself holds the
per-day overrides:

````markdown
```nautilus
end: 02:00
```
05:00-06:00 Morning routine
- [ ] Write project brief 45m
- [ ] Review notes 30m
11:45-12:30 Lunch
- [ ] Reply to email
````

The fenced block holds **per-day overrides** (leave it empty to use your global
settings); the plan itself lives **below** the block as ordinary Markdown, so it
stays editable, reorderable, and visible to Tasks and Dataview. The plan ends at
the first blank line. Both ```` ```nautilus ```` and the shorter ```` ```naut ````
are accepted.

- **A time range pins the line to the clock** — `12:30-14:00`, `9 to 10:45`.
  This works with or without a checkbox, so `- [ ] 09:00-10:00 Standup` is a
  fixed event you can still tick off.
- **A single start time also pins it** — `- [ ] 09:00 Write brief 30m` becomes
  09:00–09:30. Without a duration it uses the configured default.
  A bare number is *not* read as a time (`Read chapter 9` stays flexible);
  write `9:00` or `9am` to mean a clock time.
- **An unchecked task with no clock time is flexible** — it flows into whatever
  time remains.
- **Line order is priority.** Reorder the lines and the schedule follows.
- Durations support `30m`, `30min`, `1h`, and `1h30m`.

### Completed work

A completed task needs a **completion time** to be drawn — the engine refuses to
invent history it was not given. Write it as a `d`-prefixed anchor:

```markdown
- [x] Academic reading 40m d11:20
```

That renders as a muted 10:40–11:20 slice. Without the anchor the task still
counts as done (it stops consuming capacity) but cannot be placed on the chart.

Rather than typing anchors by hand, use the command **Complete task with
timestamp**, which ticks the current line and appends the current time. It ships
with **no default hotkey** — bind one in Settings → Hotkeys if you want it.

### Style

Events read best as list items too, so they line up with tasks:

```markdown
- 08:30-09:30 Morning routine
- [ ] Write brief 45m
```

Bare lines (`08:30-09:30 Morning routine`) still parse, but mixing the two looks
inconsistent once rendered.

## Execution layer

The optional **execution layer** records how the plan actually went. It is **off by
default**: the setting tab keeps its four sub-settings hidden until you turn on
**Actual time tracking**.

When enabled, the first ```nautilus block on today's Daily Note becomes the
**Primary Plan**, and the execution panel offers three views:

| View | Purpose |
| --- | --- |
| Timing | The current Timing Line and recently closed tasks |
| Plan | Unfinished direct-child tasks from the Primary Plan |
| Review | Today's Planned vs Actual |

Time is written into your note next to the task as Org-style CLOCK lines under a
`LOGBOOK::` drawer:

```markdown
- [ ] Write report 45m
    - LOGBOOK::
        - CLOCK: [2026-08-24 Mon 10:00]--[2026-08-24 Mon 10:18] => 0:18
```

- **Only an unfinished task can own the Timing Line**, and only one CLOCK runs at a
  time — switching tasks closes the previous CLOCK and opens the next at the same
  instant.
- With **Timing line in sidebar** on, Clock In also fronts the active task in the
  right sidebar.
- **Recent** keeps the last 45 minutes of closed work (Recent retention minutes;
  `0` disables).
- The **Pomodoro threshold** (45 min) changes only the live signal when reached —
  it never stops work. With no task CLOCK active, the panel header starts a
  standalone count-up POMO that writes nothing and touches neither Actual, Planned,
  Review, nor the spiral; starting a task CLOCK clears it, because CLOCK always has
  priority.
- The **forgotten-timer warning** (120 min) flags a CLOCK left running that long.
  It warns — it never stops or deletes a CLOCK. `0` disables it.
- Actual time is never capped at Planned. Without an explicit completion anchor
  (`dHH:MM`) or an Actual end, Nautilus Log does not invent history.

## Differences from the Roam original

| | Roam original | This port |
|---|---|---|
| Component | `{{[[roam/render]]:((uid))}}` | ` ```nautilus ` code block |
| Plan source | child blocks | Markdown below the block (block holds per-day overrides) |
| Task identity | `:block/uid` | `filepath:line` |
| Reactivity | `roam.datascript.reactive` | `metadataCache` events |
| Renderer | ClojureScript / Reagent (SCI) | TypeScript / SVG |
| Panel mount | DOM-scraped Roam topbar | Obsidian right-sidebar ItemView (`nautilus-log-view`) |
| iCal subscriptions | dropped upstream in gen 3 | not planned |

The scheduling and capacity engine is reused **unchanged** from the Roam version.

## Credits

This project stands on four generations of prior work. Each layer is
acknowledged, in order:

- **[roam-depot-render-template](https://github.com/8bitgentleman/roam-depot-render-template)**
  by [Matt Vogel](https://github.com/8bitgentleman) — the Roam extension
  scaffolding the whole lineage descends from, and the copyright holder named in
  the MIT license this project still carries.
- **[Nautilus](https://github.com/tombarys/roam-depot-nautilus)**
  by [Tomáš Barys](https://github.com/tombarys) — the original spiral-planning
  concept. The spiral is not decoration: its narrowing coils mirror one's
  diminishing energy for creative work over a day.
- **[Nautilus Enhanced](https://github.com/hopeserena/nautilus-enhanced)**
  by [hopeserena](https://github.com/hopeserena) — eliminated the timer memory
  leak, added bilingual settings, Bézier connectors, and CJK typography fixes.
- **[Nautilus Log](https://github.com/404KSG/roam-nautilus-log)**
  by [404KSG](https://github.com/404KSG) — the direct parent of this port. Added
  the capacity model (Planned / Available / Overload / No fitting slot), the
  optional execution layer with `LOGBOOK::` / `CLOCK:` tracking, Planned-vs-Actual
  review, overnight chart windows, and a test suite. **This port reuses its
  scheduling engine verbatim.**
- **[Roam Logbook](https://github.com/forrestchang/roam-logbook)**
  by [forrestchang](https://github.com/forrestchang) — the inspiration upstream
  drew on for compatible CLOCK tracking.

The time-allocation philosophy is inspired by the
[YNAB Method](https://www.ynab.com/the-four-rules/). Nautilus Log is not
affiliated with YNAB.

Released under the original MIT license, unchanged.
