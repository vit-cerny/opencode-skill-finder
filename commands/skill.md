---
description: Load the best skill for a task. Usage: /skill <task>
subagent: false
---

The user wants a skill for this task: `$ARGUMENTS`

1. Resolve it:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.config\opencode\scripts\skill-find.ps1" -Task "$ARGUMENTS"
```

2. Load exactly ONE of the returned ids with the `skill` tool. If the output listed
   candidates and none fits, run the same command with `-List` and pick from the
   compact index yourself.

3. Record it so `-Promote` can lift hot skills into the always-advertised set:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.config\opencode\scripts\skill-find.ps1" -Use <id> -Task "$ARGUMENTS"
```

4. Then do the actual task, following the loaded skill.

Report in at most three lines: skill loaded, why it matched, what you did next.
Never read several `SKILL.md` files looking for a fit.
