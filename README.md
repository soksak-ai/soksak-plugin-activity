# soksak-plugin-activity

The activity log in a project-window sidebar — the **same hub stream** the orchestrator feed renders, shown where you work. Entries whose spec carries `tts` are read aloud by the [soksak-plugin-vtube-tts](https://github.com/soksak-ai/soksak-plugin-vtube-tts) character.

한국어: [README.ko.md](README.ko.md)

```
activity hub (core) ──> orchestrator feed
        └─ plugin event "activity" ──> this sidebar (same entries)
                                          └─ tts entries → vtube-tts.say (spec tts:false — no feedback loop)
```

## Behavior

- Backfill via `activity.recent` + live via the `activity` plugin event — no polling, no window filter (whole stream, orchestrator parity)
- Narration follows the MESSAGE-PROTOCOL tts spec only: entries with `payload.tts` are spoken **in arrival order, no skipping**; entries without it (e.g. `turn.ended` AI utterances, `say` executions) are silent. This plugin invents no read rules of its own
- `vtube` toggle (sidebar button / setting / command): on = mascot appears + narration, off = text log only
- Depends on `soksak-plugin-vtube-tts` — installing this plugin installs the engine too

## Commands

`plugin.soksak-plugin-activity.<name>`: `ping` · `list {limit}` (entries with tts/narrated flags) · `vtube.toggle {on?}`
