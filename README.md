# Nautilus Log for Obsidian

> **Give every minute a job.**

A visual day planner for [Obsidian](https://obsidian.md/). Nautilus Log turns one
note into a living spiral schedule: fixed events stay fixed, flexible tasks flow
into the time that remains, and overload never disappears from view.

**A port of [Nautilus Log for Roam Research](https://github.com/404KSG/roam-nautilus-log)**
— see [Credits](#credits) for the full lineage.

> ⚠️ **Status: early development.** Nothing is installable yet. The scheduling
> engine is being ported first; the spiral renderer follows.

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
keeps the plan **inside the code block**, because Obsidian code blocks have
siblings rather than children:

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

- A time range is a fixed event.
- An unchecked task is a flexible task.
- Line order is priority.
- Durations support `30m`, `30min`, `1h`, and `1h30m`.
- Untimed tasks use the configured default.

## Differences from the Roam original

| | Roam original | This port |
|---|---|---|
| Component | `{{[[roam/render]]:((uid))}}` | ` ```nautilus ` code block |
| Plan source | child blocks | code block contents |
| Task identity | `:block/uid` | `filepath:line` (`^blockid` only when needed) |
| Reactivity | `roam.datascript.reactive` | `metadataCache` events |
| Renderer | ClojureScript / Reagent (SCI) | TypeScript / SVG |
| Panel mount | DOM-scraped Roam topbar | `addStatusBarItem()` |
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
