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

## How do I use it?

Nothing to remember. When a prompt matches a skill, the model is told which one
to load, and you will see it happen. The commands exist for when you want to look
or steer.

**Day to day** — just ask. If a skill matches, it gets used. To see what happened:

```
/skilllog        # what was auto-loaded or hinted recently
/skillstats      # token accounting
/skilldoctor     # health check: plugin loaded? finder still advertised? token cost?
```

**When you want control:**

```
/skills                    # list every skill you have
/skill refactor this module into smaller files   # find + load the best skill, then do it
/skillpromote              # show usage, then make frequently used skills always-advertised
/skillpromote 3            # same, with a threshold of 3 uses
```

**When you add skills:**

```
/skillfinder add some-owner/some-repo   # npx skills add, then re-hide the new ones
```

**Everything at once** — `/skillfinder <task|skills|commands|stats|log|doctor|enable|restore|promote|demote <id>|add <repo>>`.

Or call the script directly, from anywhere:

```powershell
$sk = "$env:USERPROFILE\.config\opencode\scripts\skill-find.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File $sk -Task "<the task>"
powershell -NoProfile -ExecutionPolicy Bypass -File $sk -Doctor
```

| Flag | Does |
|---|---|
| `-Task "<text>"` | Keyword-filter the index, print the matches (default `-Top 3`) |
| `-List` | Compact one-line-per-skill index, on demand |
| `-Commands` | Every command the running server exposes, plus built-ins |
| `-Doctor` | Health check: counts, token cost, plugin status, log size |
| `-Log [n]` | Tail of the audit log (default 20 lines) |
| `-Use <id> -Task "<text>"` | Record a use, feeding `-Promote` |
| `-Promote [-Threshold n]` | Unhide skills used >= n times (default 5) |
| `-Demote <id>` | Hide one again |
| `-Enable` / `-Restore` | Hide all but the finder / unhide all |
| `-Status` | Token accounting, usage table, what is still advertised |
| `-Online` | Also query the skills.sh catalog |
| `-Top n` | How many matches to print |

## Will it waste tokens?

Measured on this machine, 53 skills:

| | Tokens |
|---|---|
| Before: every skill advertised | **4,124 per request**, whether or not you use a skill |
| After: one finder advertised | **61 per request** — the 52 others are hidden |
| The hint (when skills match) | ~90 per turn, once |
| Auto-load (only when you name a skill) | the one skill's body |

So the standing cost drops by 98.5%, and the only new cost is per-turn and
proportional to actually using something. Skill bodies are still never loaded
just because a skill exists — that is the whole point of hiding them.

The finder can print the full index on demand (~1,400 tokens for 53 skills) when
keyword matching is ambiguous. That is a fallback you ask for, not a tax you pay
every request.


## How it works

Two mechanisms, one goal.

**`scripts/skill-find.ps1`** — the on-demand resolver. Scans
`~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills`, then the
project's `.opencode/skills`, `.claude/skills` and `.agents/skills` (current
directory and parent). First root that defines a name wins, matching opencode.
Reads frontmatter only, never skill bodies. Writes a cached
`skill-index.json`.

**`plugins/skill-hint.ts`** — makes it automatic. It registers two opencode V2
session hooks in `setup()`:

- `prompt` — on prompt admission, filters the same index against the incoming
  text and picks a skill. If the prompt names a skill whose id token is **unique**
  across all skill ids (e.g. "run ponytail", "make a graphify graph"), that skill
  is pushed onto `event.prompt.skills`, which opencode resolves natively — it is
  genuinely loaded, once, with no model discretion and no extra tool call.
  Otherwise a shortlist is queued as a hint.
- `context` — on the next model call, pushes that hint into the system prompt
  (`event.system`), then clears it, so tool-driven continuations do not pay for
  it again.

The hint is worded as a requirement, so a matching task reliably loads something:

```
[skill-hint] MANDATORY before any other tool call: load exactly one of these
with the skill tool - security-review, code-review-and-quality - or state in one
line why none of them applies to this task.
```

Every delivery is appended to `~/.config/opencode/skill-hint.log`:

```
2026-10-15T20:19:32.660Z auto-loaded: find-skills (others: playwright, xlsx)
2026-10-15T20:20:02.261Z delivered: find-skills is already loaded for this task...
```

The plugin never throws: a plugin error must not break a session. Nothing is
added to your message — the hint lives in the system prompt, so your transcript
stays clean.

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

21 checks: index builds, hidden flags parse, stemming, three real task-to-skill
mappings, short-text and marker dedupe, no match on chit-chat, and six
auto-load precision guards.

Verified end to end on a live server, not inferred:

| Check | Evidence |
|---|---|
| Plugin loads | `opencode api GET /api/plugin` → `id=skill-hint status=active` |
| Hooks fire | `skill-hint.log` shows the prompt hook and the delivery |
| The model sees it | a subagent was asked to quote any line containing "candidates" and returned the hint verbatim |
| Delivered once per turn | later model calls log nothing; `pending` is cleared after delivery |
| Hiding works | `-Status` reports 53 skills, 1 advertised, 61 tokens/request |
| Hidden skill still loadable | `skill` tool called with `ponytail` while hidden returned its full body |
| Auto-load is precise | 4 correct auto-loads when a skill is named; 3 guards prove it does *not* fire on loose keyword matches |

The auto-load gate was rewritten twice against real failures, both caught in
`skill-hint.log` rather than by reasoning:

1. A match-count gate auto-loaded `jev-browser` for "build a settings page with a
   dark mode toggle" and `karpathy-guidelines` for "write a changelog".
2. An id-token gate auto-loaded `find-skills` for a prompt that merely contained
   the word "skills", because `skill` appears in several skill ids.

Both are now regression tests. Requiring a *unique* id token fixes them, and
explicit naming is checked across all candidates, so naming `security-review`
wins over a higher-ranked `ai-prompt-engineering-safety-review`.

Other bugs found and fixed:

- PowerShell 5.1 `Set-Content -Encoding UTF8` writes a **BOM**, which breaks
  `---` frontmatter parsing. All writes go through
  `New-Object System.Text.UTF8Encoding($false)`.
- Hardcoding CRLF on insert broke byte-identity on LF files. The insert reuses
  the file's own line ending — verified SHA256-identical across 78 files.
- The plugin was first written against the V1 plugin API and silently failed to
  load. V2 needs `Plugin.define({ id, setup })` as the default export from
  `@opencode/plugin`.

## What is deliberately not here

**No ranking.** An earlier version scored skills with a BM25-style ranker over
their descriptions. It was wrong: "build a settings page with a dark mode
toggle" matched `caveman`. Descriptions are marketing prose and do not share
vocabulary with task descriptions. So there is a keyword **filter** (id, name,
description) plus an on-demand compact index (~1,400 tokens for 53 skills) when
the filter is ambiguous. The model picks - it is the better semantic matcher and
it is already in the conversation.

**No runtime hiding via `ctx.skill.transform`.** V2 exposes
`Skill.Info.autoinvoke`, so hiding could in principle happen in the plugin with
no file edits, which would also survive a skill sync. It was implemented and
reverted: the transform hid *every* skill including `skill-finder` itself
(observed 2026-10-15), leaving the roster empty. Frontmatter hiding is used
instead. If you retry it, verify the finder survives before trusting it.

## Limits

- **Not true semantic matching.** Unusual phrasing can miss, and it can suggest
  a near-miss (it offered `xlsx` for a diff-review prompt). `-List` is the escape
  hatch: print the index, let the model choose. Load one skill per task.
- **Skill syncs re-advertise.** `npx skills add` installs new skills with their
  descriptions advertised, so new ones cost tokens until you re-run `-Enable`.
  There is no hook for this; it is a manual step.
- **Confined to frontmatter.** `-Enable`, `-Restore`, `-Promote` and `-Demote`
  only insert or remove one line in the frontmatter of a `SKILL.md`. Skill bodies
  are never touched. Edited paths are recorded in `skill-find-state.json`.
- **`skills.sh` search needs auth.** `https://skills.sh/api/v1/skills/search`
  returns 401 without a Vercel OIDC token, so `-Online` reports that and points at
  `npx skills add <owner/repo>` instead of pretending discovery worked.
- **Windows-first.** The resolver is PowerShell 5.1. The plugin is portable.

## Licence

MIT
