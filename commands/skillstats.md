---
description: Skill token accounting and usage table
subagent: false
---

Show the token accounting. Run exactly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.config\opencode\scripts\skill-find.ps1" -Status
```

Then report in at most four lines:
- how many skills exist, how many are advertised, how many hidden
- the measured cost per request and what it would be if everything were advertised
- the top used skills, if any

Do not load a skill. Numbers only, no advice.

Arguments, if any, are ignored: `$ARGUMENTS`
