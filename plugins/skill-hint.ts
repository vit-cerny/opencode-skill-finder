import { Plugin } from "@opencode/plugin"
import { readdirSync, readFileSync, existsSync, appendFileSync, writeFileSync, statSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"

/**
 * skill-hint - near-zero-token skill discovery for opencode V2.
 *
 * The problem: opencode ships every skill's id, name and description to the
 * model on every request. With 53 skills that measured 16,380 chars (~4,124
 * tokens) before you type anything.
 *
 * The fix has two halves:
 *
 *  1. Hiding. Every skill except `skill-finder` carries
 *     `disable-model-invocation: true` in its frontmatter, managed by
 *     scripts/skill-find.ps1 -Enable. That drops the index to 244 chars
 *     (~61 tokens). Hidden skills stay registered and still load by id.
 *
 *  2. Nudging. Because hidden skills no longer advertise themselves, this plugin
 *     supplies the shortlist: it filters the on-disk index against the incoming
 *     prompt and injects the best candidates into the system prompt for the next
 *     model call. ~40 tokens per turn. The model still chooses and loads exactly
 *     one skill by id.
 *
 * Loaded as a local plugin from ~/.config/opencode/plugins/skill-hint.ts.
 *
 * Hard-won API notes (2026-10-15):
 *  - opencode V2 needs `Plugin.define({ id, setup })` as the DEFAULT export from
 *    `@opencode/plugin`. The v1 shape in `@opencode-ai/plugin` fails with
 *    "Plugin must export a default definition with an id and an effect or setup function."
 *  - Hiding via `ctx.skill.transform` (autoinvoke = false) was tried and REVERTED:
 *    it hid every skill including skill-finder itself. Frontmatter hiding is used
 *    instead and is verified.
 *  - The hint goes into `event.system` via the `context` hook, not into the user's
 *    message. Verified: a subagent quoted the injected line verbatim.
 */

const HOME = homedir()
const CONFIG_ROOT = join(HOME, ".config", "opencode")
const LOG_FILE = join(CONFIG_ROOT, "skill-hint.log")
const MARKER = "[skill-hint]"
const TTL_MS = 60_000
const MAX_HINT = 3

/**
 * Always injected, on every request.
 *
 * Why: this machine's AGENTS.md told the agent to load `ponytail`,
 * `karpathy-guidelines` and `no-ai-slop` as skills on every response. Their
 * bodies measure 1,697 + 674 + 2,746 = 5,117 tokens - more than the 4,124-token
 * advertised index this plugin exists to remove - and whether they actually got
 * loaded was a coin flip. This is the same rules, distilled, deterministic, and
 * ~36x cheaper. The full bodies still load on demand when a task needs detail.
 *
 * Keep it constant: an identical prefix every request stays prompt-cache friendly.
 */
export const CORE = [
  "CORE RULES (always injected; do NOT load ponytail / karpathy-guidelines / no-ai-slop as skills unless a task genuinely needs their detail):",
  "- YAGNI first: does this need to exist? Then reuse > stdlib > native > installed dep > one line.",
  "- No speculative abstraction, no scaffolding for later, no config for a constant.",
  "- Shortest working diff. Every changed line traces to what was asked.",
  "- Bug fix = root cause: grep the callers, fix where they all route through.",
  "- State assumptions and tradeoffs; stop and ask when something is unclear.",
  "- Evidence before claims: run the command, read the output, then claim.",
  "- Prose: no AI slop, no emoji, no padding, no restating the line below it.",
  "- Non-trivial logic leaves one runnable check behind.",
].join("\n")

export type Skill = { id: string; name: string; desc: string; hidden: boolean }

let cache: { at: number; cwd: string; skills: Skill[] } | null = null

/** Append one audit line (truncated past 64 KB). Best effort, never throws. */
function logLine(text: string) {
  try {
    const line = `${new Date().toISOString()} ${text}\n`
    let size = 0
    try {
      size = statSync(LOG_FILE).size
    } catch {
      size = 0
    }
    if (size > 65_536) writeFileSync(LOG_FILE, line)
    else appendFileSync(LOG_FILE, line)
  } catch {
    // logging must never break a session
  }
}

export function skillRoots(cwd: string): string[] {
  const roots: string[] = [
    join(CONFIG_ROOT, "skills"),
    join(HOME, ".claude", "skills"),
    join(HOME, ".agents", "skills"),
  ]
  for (const d of [cwd, dirname(cwd)]) {
    roots.push(join(d, ".opencode", "skills"), join(d, ".claude", "skills"), join(d, ".agents", "skills"))
  }
  return [...new Set(roots)].filter((p) => {
    try {
      return existsSync(p)
    } catch {
      return false
    }
  })
}

/** Read frontmatter only - bodies reach 26 KB and are never needed here. */
export function readFront(file: string): { name: string; desc: string; hidden: boolean } | null {
  let raw = ""
  try {
    raw = readFileSync(file, "utf8")
  } catch {
    return null
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  if (!raw.startsWith("---")) return null
  const end = raw.indexOf("\n---", 3)
  const head = end === -1 ? raw.slice(0, 2000) : raw.slice(0, end)

  const hidden =
    /^disable-model-invocation:[ \t]*true[ \t]*$/m.test(head) || /(?:opencode\/)?autoinvoke:[ \t]*false/m.test(head)

  const nameM = head.match(/^name:[ \t]*(.+)$/m)
  let desc = ""
  const inline = head.match(/^description:[ \t]*(.+)$/m)
  if (inline && !/^[>|][-+]?$/.test(inline[1].trim())) {
    desc = inline[1].trim().replace(/^["']|["']$/g, "")
  } else {
    const block = head.match(/^description:[ \t]*[>|][-+]?[ \t]*\n((?:[ \t]+\S.*\n?)+)/m)
    if (block) {
      desc = block[1]
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .join(" ")
    }
  }
  return { name: nameM ? nameM[1].trim() : "", desc, hidden }
}

export function buildIndex(cwd: string): Skill[] {
  const seen = new Set<string>()
  const out: Skill[] = []
  for (const root of skillRoots(cwd)) {
    let names: string[] = []
    try {
      names = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      continue
    }
    for (const id of names) {
      if (seen.has(id)) continue
      const f = join(root, id, "SKILL.md")
      try {
        if (!existsSync(f)) continue
      } catch {
        continue
      }
      const fr = readFront(f)
      if (!fr) continue
      seen.add(id)
      out.push({ id, name: fr.name || id, desc: fr.desc, hidden: fr.hidden })
    }
  }
  return out
}

export function getIndex(cwd: string): Skill[] {
  const now = Date.now()
  if (cache && cache.cwd === cwd && now - cache.at < TTL_MS) return cache.skills
  try {
    const skills = buildIndex(cwd)
    cache = { at: now, cwd, skills }
    return skills
  } catch {
    return cache ? cache.skills : []
  }
}

const STOP = new Set([
  "the","and","for","with","that","this","from","into","your","you","are","was","were","have","has","had",
  "not","but","all","any","can","will","would","should","could","when","then","than","them","they","their",
  "there","here","its","our","out","use","using","used","make","makes","made","get","gets","got","new","add",
  "adds","added","need","needs","want","wants","please","help","how","what","why","does","doing","done",
  "also","just","like","some","more","most","very","only","other","over","under","about","after","before",
  "while","where","which","who","whom","file","files","code","work","task","thing","let","lets","now","one",
  "two","via","per","run","runs","running","to","of","in","on","at","is","it","be","do","or",
])

export function stem(w: string): string {
  if (w.length < 4) return w
  for (const suf of ["ations", "ation", "ings", "ing", "ies", "ied", "ers", "ed", "es", "s", "ly"]) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) {
      let base = w.slice(0, w.length - suf.length)
      if (suf === "ies") return base + "y"
      if ((suf === "ing" || suf === "ed") && base.length >= 2 && base[base.length - 1] === base[base.length - 2]) {
        base = base.slice(0, -1)
      }
      return base
    }
  }
  return w
}

export function tokens(text: string): string[] {
  if (!text) return []
  const raw = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ")
  const out: string[] = []
  for (const w of raw) {
    if (w.length < 3 || STOP.has(w)) continue
    out.push(stem(w))
  }
  return [...new Set(out)]
}

/** Token equality is brittle after crude stemming ("brows" vs "browser"), so a
 *  query token also hits when it shares a >=4-char prefix with a hay token. */
function hits(q: string, hay: Set<string>): boolean {
  if (hay.has(q)) return true
  if (q.length < 4) return false
  for (const h of hay) {
    if (h.length >= 4 && (h.startsWith(q) || q.startsWith(h))) return true
  }
  return false
}

export type Ranked = { id: string; m: number }

/** Keyword filter, not a ranker. Scores are match counts over id/name/description. */
export function rank(text: string, cwd: string): Ranked[] {
  const q = tokens(text)
  if (q.length === 0) return []
  const scored: Ranked[] = []
  for (const s of getIndex(cwd)) {
    if (s.id.startsWith("skill-")) continue
    const hay = new Set(tokens(`${s.id} ${s.name} ${s.desc}`))
    let m = 0
    for (const t of q) if (hits(t, hay)) m++
    if (m > 0) scored.push({ id: s.id, m })
  }
  scored.sort((a, b) => b.m - a.m || a.id.localeCompare(b.id))
  return scored
}

export function candidates(text: string, cwd: string): string[] {
  return rank(text, cwd)
    .slice(0, MAX_HINT)
    .map((x) => x.id)
}

/** Lowercase, non-alphanumerics to single spaces, padded so phrase lookups are word-bounded. */
export function phrase(s: string): string {
  return " " + s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim() + " "
}

/**
 * Auto-load is restricted to a high-precision signal: the prompt contains the
 * skill's id as a contiguous phrase ("run ponytail", "use web-design-engineer").
 * Everything else gets a hint, because the keyword filter is not reliable enough
 * to inject a whole skill body.
 *
 * Three measured failures drove this, all caught in skill-hint.log:
 *  - a match-count gate auto-loaded `jev-browser` for "build a settings page with
 *    a dark mode toggle" and `karpathy-guidelines` for "write a changelog";
 *  - an id-token gate auto-loaded `find-skills` for any prompt containing the
 *    word "skills", because `skill` appears in several skill ids;
 *  - a unique-token gate auto-loaded `find-skills` again for the `/skills`
 *    command, whose body contains "skill-find.ps1" and therefore the token "find".
 * A wrong auto-load costs the full body (5-30 KB) and steers the agent wrong.
 */
export function pick(text: string, cwd: string): { id: string; explicit: boolean; rest: string[] } | null {
  const r = rank(text, cwd)
  if (r.length === 0) return null

  const q = phrase(text)
  // A skill the user actually named beats keyword ranking, even if another skill
  // scored higher (naming "security-review" used to lose to
  // "ai-prompt-engineering-safety-review"). The id must appear as a contiguous
  // phrase, which is what stops this from firing on unrelated text:
  // "/skills" ran a command body containing "skill-find.ps1", and the bare token
  // "find" used to auto-load find-skills.
  const hit = r.find((x) => q.includes(phrase(x.id)))
  if (hit) return { id: hit.id, explicit: true, rest: r.filter((x) => x.id !== hit.id).slice(0, MAX_HINT).map((x) => x.id) }

  const top = r[0]
  return { id: top.id, explicit: false, rest: r.slice(1, MAX_HINT).map((x) => x.id) }
}

export function hintFor(text: string, cwd: string, autoLoaded?: string | null): string | null {
  if (!text || text.includes(MARKER)) return null
  if (text.trim().length < 12) return null
  const ids = candidates(text, cwd)
  if (ids.length === 0) return null

  if (autoLoaded) {
    const others = ids.filter((x) => x !== autoLoaded)
    return (
      `${MARKER} ${autoLoaded} is already loaded for this task. ` +
      (others.length ? `Other candidates: ${others.join(", ")}. If one fits better, load it with the skill tool. ` : "") +
      `Need something else: skill-find.ps1 -Task "<task>" or -List; add -Online to search the skills.sh catalog.`
    )
  }

  return (
    `${MARKER} MANDATORY before any other tool call: load exactly one of these with the skill tool ` +
    `- ${ids.join(", ")} - or state in one line why none of them applies to this task. ` +
    `They are hidden to save context but still load by id. ` +
    `Need a different one: skill-find.ps1 -Task "<task>" or -List; add -Online to search the skills.sh catalog.`
  )
}

export default Plugin.define({
  id: "skill-hint",
  async setup(ctx) {
    const cwd = ctx.location?.directory ?? process.cwd()
    const pending = new Map<string, string>()

    // On prompt admission: auto-load the best skill when the filter is
    // confident, and queue a hint describing what was loaded. opencode resolves
    // event.prompt.skills natively, so the skill is loaded once, up front, with
    // no model discretion and no extra tool call.
    try {
      await ctx.session.hook("prompt", (event) => {
        try {
          const text = (event?.prompt as any)?.text ?? ""
          const choice = pick(text, cwd)

          if (!choice) {
            logLine(`prompt: no candidate matched (${text.trim().slice(0, 50)})`)
            return
          }

          let autoLoaded: string | null = null
          if (choice.explicit) {
            const prompt = event.prompt as any
            if (Array.isArray(prompt.skills) || prompt.skills === undefined) {
              prompt.skills = [...(prompt.skills ?? []), { id: choice.id }]
              autoLoaded = choice.id
            }
          }

          const hint = hintFor(text, cwd, autoLoaded)
          if (hint) pending.set(event.sessionID, hint)
          logLine(
            `${autoLoaded ? "auto-loaded" : "hint only"}: ${autoLoaded ?? choice.id}` +
              (choice.rest.length ? ` (others: ${choice.rest.join(", ")})` : ""),
          )
        } catch (e) {
          logLine(`prompt hook error: ${String(e)}`)
        }
      })
    } catch (e) {
      logLine(`prompt hook registration failed: ${String(e)}`)
    }

    // Deliver into the system prompt on the next model call, then clear, so
    // tool-driven continuations do not pay for it again.
    try {
      await ctx.session.hook("context", (event) => {
        try {
          event.system.push({ type: "text", text: CORE })

          const hint = pending.get(event.sessionID)
          if (!hint) return
          event.system.push({ type: "text", text: hint })
          pending.delete(event.sessionID)
          logLine(`delivered: ${hint.replace(`${MARKER} `, "").slice(0, 90)}`)
        } catch (e) {
          logLine(`context hook error: ${String(e)}`)
        }
      })
    } catch (e) {
      logLine(`context hook registration failed: ${String(e)}`)
    }

    logLine(`setup: dir=${cwd}`)
  },
})
