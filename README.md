# opencode-skill-finder

Skill discovery for [opencode](https://opencode.ai) that keeps the per-request
skill index near zero and still puts the right skill in front of the model.

## The problem

opencode ships every skill's id, name and description to the model on every
request. On a machine with 53 skills that measured as:

```
53 skills advertised  ->  16,380 chars  ->  ~4,124 tokens per request
```

Before you type anything. Most of it is never used in a given session, and the
number grows every time you install a skill pack.

## The fix

[`disable-model-invocation: true`](https://opencode.ai/docs/skills) in a skill's
frontmatter removes it from the advertised list **while keeping it registered
and loadable by id**. So:

- hide every skill, advertise exactly one tiny finder,
- resolve the best skill per task,
- promote back to always-advertised whatever you actually use often.

Measured on the same 53 skills:

```
 1 skill advertised   ->     244 chars  ->     ~61 tokens per request
52 skills hidden      ->  loadable by id, just not shipped in every prompt
```

A 98.5% cut in index cost, with no skill made unreachable. Verified: calling the
`skill` tool with the id of a hidden skill returns its full body.

## Install

```powershell
git clone https://github.com/vit-cerny/opencode-skill-finder
cd opencode-skill-finder
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

That copies the four pieces into `~/.config/opencode`, hides every skill except
`skill-finder`, and prints the token accounting. It is idempotent.

Manual install is the same thing by hand:

| File | Goes to |
|---|---|
| `skills/skill-finder/SKILL.md` | `~/.config/opencode/skills/skill-finder/SKILL.md` |
| `commands/skillfinder.md` | `~/.config/opencode/commands/skillfinder.md` |
| `scripts/skill-find.ps1` | `~/.config/opencode/scripts/skill-find.ps1` |
| `plugins/skill-hint.ts` | `~/.config/opencode/plugins/skill-hint.ts` |

then run `scripts/skill-find.ps1 -Enable`.

## Usage

From a slash command:

```
/skillfinder add a playwright test for checkout   # resolve + load one skill
/skillfinder skills                               # list every skill
/skillfinder commands                             # list every command
/skillfinder status                               # token accounting + usage table
/skillfinder promote                              # skills used >= 5x become always-advertised
/skillfinder enable                               # re-hide after a skill sync
/skillfinder restore                              # unhide everything
/skillfinder add <owner/repo>                     # npx skills add, then re-hide
```

Or call the script directly:

```powershell
sk = "$env:USERPROFILE\.config\opencode\scripts\skill-find.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File $sk -Task "<the task>"
powershell -NoProfile -ExecutionPolicy Bypass -File $sk -List
powershell -NoProfile -ExecutionPolicy Bypass -File $sk -Use web-design-engineer -Task "<the task>"
powershell -NoProfile -ExecutionPolicy Bypass -File $sk -Promote -Threshold 5
```

| Flag | Does |
|---|---|
| `-Task "<text>"` | Keyword-filter the index, print the matches (default `-Top 3`) |
| `-List` | Compact one-line-per-skill index, on demand |
| `-Commands` | Every command the running server exposes, plus built-ins |
| `-Use <id> -Task "<text>"` | Record a use, feeding `-Promote` |
| `-Promote [-Threshold n]` | Unhide skills used >= n times (default 5) |
| `-Demote <id>` | Hide one again |
| `-Enable` / `-Restore` | Hide all but the finder / unhide all |
| `-Status` | Token accounting, usage table, what is still advertised |
| `-Online` | Also query the skills.sh catalog |
| `-Top n` | How many matches to print |

## How it works

Two mechanisms, one goal.

**`scripts/skill-find.ps1`** — the on-demand resolver. Scans
`~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills`, then the
project's `.opencode/skills`, `.claude/skills` and `.agents/skills` (current
directory and parent). First root that defines a name wins, matching opencode.
Reads frontmatter only, never skill bodies. Writes a cached
`skill-index.json`.

**`plugins/skill-hint.ts`** — makes it automatic. Hooks `chat.message`, keyword-
filters the same index against your message, and appends one line naming the top
candidates:

```
[skill-hint] skill candidates: security-review, code-review-and-quality.
Load exactly one with the skill tool before specialized work - they are hidden
to save context but still load by id.
```

~40 tokens per message, versus ~4,124 per request for the full index. The model
still chooses and loads one skill; the plugin only supplies the shortlist. It
never throws - a plugin error must not break a session.

**Design tradeoff:** the hint is appended to the incoming user message, so it is
visible in the transcript rather than hidden in the system prompt. That is
deliberate - you can see which skills were suggested and why. The alternative is
to stash it in `chat.message` and inject it in
`experimental.chat.system.transform`, which keeps your message clean but adds an
ordering assumption between the two hooks.

## What is deliberately not here

An earlier version ranked skills with a BM25-style scorer over their
descriptions. It was wrong: "build a settings page with a dark mode toggle"
matched `caveman`. Descriptions are marketing prose and do not share vocabulary
with task descriptions.

So there is **no ranking**, only a keyword filter over the id, name and
description, plus an on-demand compact index (~1,400 tokens for 53 skills) when
the filter is ambiguous. The model picks. It is the better semantic matcher, and
it is already in the conversation.

## Verification

```powershell
bun run test/skill-hint.test.ts
```

13 checks: index builds, hidden flags parse, stemming, three real task-to-skill
mappings, short-text and marker dedupe, no match on chit-chat, hint size.

The hide/restore round-trip was verified byte-identical across 78 `SKILL.md`
files (56 CRLF, 22 LF) using SHA256. Two bugs found and fixed during that work:

- PowerShell 5.1 `Set-Content -Encoding UTF8` writes a **BOM**, which breaks
  `---` frontmatter parsing. All writes go through
  `New-Object System.Text.UTF8Encoding($false)`.
- Hardcoding CRLF on insert broke byte-identity on LF files. The insert reuses
  the file's own line ending.

## Limits

- **Not true semantic matching.** Unusual phrasing can miss. `-List` is the
  escape hatch: print the index, let the model choose.
- **Skill syncs re-advertise.** `npx skills add` installs new skills with their
  descriptions advertised, so new ones cost tokens until you re-run `-Enable`.
  There is no hook for this; it is a manual step.
- **Confined to frontmatter.** `-Enable`, `-Restore`, `-Promote` and `-Demote`
  only insert or remove one line in the frontmatter of a `SKILL.md`. Skill
  bodies are never touched. Edited paths are recorded in
  `skill-find-state.json`.
- **`skills.sh` search needs auth.** `https://skills.sh/api/v1/skills/search`
  returns 401 without a Vercel OIDC token, so `-Online` reports that and points
  at `npx skills add <owner/repo>` instead of pretending discovery worked.
- **Windows-first.** The resolver is PowerShell 5.1. The plugin is portable.

## Licence

MIT
