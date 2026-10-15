---
description: Promote skills you use often to always-loaded. Usage: /skillpromote [threshold]
subagent: false
---

Promote hot skills. `$ARGUMENTS` is the optional use-count threshold; default 5.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.config\opencode\scripts\skill-find.ps1" -Promote -Threshold <threshold>
```

If the threshold was not given, run `-Status` first and show the usage table so the
user can pick. Then run `-Promote` with that number.

Explain in two lines: promoted skills are advertised in every request again (they cost
their description, roughly 40-250 tokens each) but stop needing a finder lookup.
Reverse one with `-Demote <id>`.
