---
description: List every skill available on this machine, with its token status
subagent: false
---

List all skills. Run exactly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.config\opencode\scripts\skill-find.ps1" -List
```

Then show the user the list as-is and add one line with the counts: how many skills
exist, how many are advertised (costing tokens every request), how many are hidden
(loaded only on demand). Get those counts from `-Status` if you need them.

Do not load any skill. Do not editorialise about which skills are good.
Arguments, if any, are ignored: `$ARGUMENTS`
