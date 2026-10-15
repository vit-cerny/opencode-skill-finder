---
description: Token-lean skill discovery. Usage: /skillfinder <task> | enable | restore | promote | status | add <owner/repo>
subagent: false
---

The user invoked the skill finder with: `$ARGUMENTS`

Run the resolver, never guess:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.config\opencode\scripts\skill-find.ps1" <args>
```

Map `$ARGUMENTS` to the script arguments:

| `$ARGUMENTS` | Run |
|---|---|
| a task description (default) | `-Task "<the text>"` |
| `skills` | `-List` |
| `commands` | `-Commands` |
| `stats` | `-Status` |
| `log` | `-Log 30` |
| `doctor` | `-Doctor` |
| `enable` | `-Enable` then `-Status` |
| `restore` | `-Restore` |
| `promote` | `-Promote` |
| `demote <id>` | `-Demote <id>` |
| `add <owner/repo>` | `npx skills add <owner/repo>`, then `-Enable`, then `-Status` |

There are also first-class commands: `/skills` (list), `/skill <task>` (find+load),
`/skillstats`, `/skilllog`, `/skillpromote`, `/skilldoctor`.

Then:

1. If the finder returned a skill, load it with the `skill` tool (by id). Hidden
   skills load fine by id; the printed `path` is the fallback.
2. Record the use: `-Use <id>` so `-Promote` can lift hot skills into the
   always-advertised set.
3. Report in at most three lines: which skill, why it matched, what you loaded.
   If nothing matched, say so and continue without a skill - do not read
   `SKILL.md` files hunting for a fit.
