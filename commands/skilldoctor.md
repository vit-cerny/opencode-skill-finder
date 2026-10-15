---
description: Health check the skill finder (plugin, token cost, log)
subagent: false
---

Run the health check:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.config\opencode\scripts\skill-find.ps1" -Doctor
```

Report its output verbatim, then flag only these two things if they appear:
- `finder advertised : NO` - the only advertised skill is gone, run `-Enable`.
- a plugin line with `failed` - the plugin is not loaded; the reason is on that line.

Otherwise one line: everything is healthy. Do not load a skill, do not suggest changes
that the doctor did not report.

Arguments, if any, are ignored: `$ARGUMENTS`
