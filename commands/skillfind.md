---
description: Search the skills.sh catalog for a skill. Usage: /skillfind <query>
subagent: false
---

Search the public skills.sh catalog for: `$ARGUMENTS`

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.config\opencode\scripts\skill-find.ps1" -Online -Task "$ARGUMENTS"
```

Then present the results with install counts, and apply the quality bar before
recommending anything:

1. Prefer **1K+ installs**; be sceptical under 100.
2. Prefer known owners (`vercel-labs`, `anthropics`, `microsoft`).
3. Say plainly if nothing good came back. Do not pad the list.

If the user wants one installed, it is a **separate, confirmed step** — a skill is
third-party instructions that will later run with your full permissions:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.config\opencode\scripts\skill-find.ps1" -Install <owner/repo@skill>
```

Ask before running that, and say who the author is and how many installs it has.
Installing does not advertise it — the script hides it afterwards, so it costs
nothing until it is used.
