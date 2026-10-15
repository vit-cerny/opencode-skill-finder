---
name: skill-finder
description: Resolve the single best skill for the current task, then load only that one. Use before any specialized work - docs, design, UI, tests, security, browser, debugging, loops, writing, skill authoring - or whenever unsure which capability applies.
---

# skill-finder

Skill bodies are not injected up front on this machine. Almost every skill is
**hidden** from the model's advertised list (`disable-model-invocation: true`) to
keep the per-request index near zero. `skill-find.ps1` is the resolver.

## Loop

1. **Find** - before specialized work, resolve the skill:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.config\opencode\scripts\skill-find.ps1" -Task "<the actual task>"
   ```

2. **Load** - take the top `id` and load it with the `skill` tool. Hidden skills
   are still registered and loadable by id. If the id is rejected, read the
   `path` the script printed - that is the same file.

3. **Record** - after using it, so hot skills can be promoted:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.config\opencode\scripts\skill-find.ps1" -Use <id> -Task "<the task>"
   ```

## Commands

| Need | Command |
|---|---|
| Best skill for a task | `-Task "<task>"` (add `-Top 3` for options) |
| Record a use | `-Use <id> -Task "<task>"` |
| Promote skills used >= 5 times to always-advertised | `-Promote` (or `-Promote -Threshold 3`) |
| Hide a skill again | `-Demote <id>` |
| Hide every skill, keep the finder | `-Enable` (idempotent - re-run after any skill sync) |
| Undo `-Enable` | `-Restore` |
| Token accounting + usage table | `-Status` |
| Also query the skills.sh catalog | add `-Online` |

## Rules

- Load ONE skill per task. Two is a smell; say why in one line if you do.
- Do not read many `SKILL.md` files looking for a fit - that is the token waste
  this replaces. One finder call, one load.
- If the task needs a capability no local skill covers, try
  `npx skills add <owner/repo>` (see `-Online`), then `-Enable` to hide the new
  skill so it costs nothing until used.
- `-Enable` only rewrites frontmatter. It never touches a skill body, and
  `-Restore` undoes it exactly.
