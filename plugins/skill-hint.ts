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

/** Keyword filter, not a ranker. Returns at most MAX_HINT ids, best first. */
export function candidates(text: string, cwd: string): string[] {
  const q = tokens(text)
  if (q.length === 0) return []
  const scored: Array<[number, string]> = []
  for (const s of getIndex(cwd)) {
    if (s.id.startsWith("skill-")) continue
    const hay = new Set(tokens(`${s.id} ${s.name} ${s.desc}`))
    let m = 0
    for (const t of q) if (hits(t, hay)) m++
    if (m > 0) scored.push([m, s.id])
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]))
  return scored.slice(0, MAX_HINT).map((x) => x[1])
}

export function hintFor(text: string, cwd: string): string | null {
  if (!text || text.includes(MARKER)) return null
  if (text.trim().length < 12) return null
  const ids = candidates(text, cwd)
  if (ids.length === 0) return null
  return (
    `${MARKER} skill candidates: ${ids.join(", ")}. ` +
    `Load exactly one with the skill tool before specialized work - they are hidden to save context but still load by id. ` +
    `Need a different one: skill-find.ps1 -Task "<task>" or -List.`
  )
}

export default Plugin.define({
  id: "skill-hint",
  async setup(ctx) {
    const cwd = ctx.location?.directory ?? process.cwd()
    const pending = new Map<string, string>()

    // Compute the shortlist when a prompt is admitted.
    try {
      await ctx.session.hook("prompt", (event) => {
        try {
          const text = (event?.prompt as any)?.text ?? ""
          const hint = hintFor(text, cwd)
          if (hint) pending.set(event.sessionID, hint)
          else logLine(`prompt: no candidate matched (${text.trim().slice(0, 50)})`)
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
