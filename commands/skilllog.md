---
description: Show which skills the plugin auto-loaded or hinted recently
subagent: false
---

Show the skill-hint audit log. Run exactly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.config\opencode\scripts\skill-find.ps1" -Log 30
```

Then summarise in at most five lines: which skills were auto-loaded, which were
hinted, and any `prompt: no candidate matched` lines (those are tasks where the
filter found nothing - useful to know, not a failure).

Do not load a skill.

Arguments, if any, are ignored: `$ARGUMENTS`
