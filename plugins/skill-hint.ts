import type { Plugin } from "@opencode-ai/plugin"
import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"

/**
 * skill-hint - makes the skill finder automatic.
 *
 * Every skill except `skill-finder` carries `disable-model-invocation: true`, so
 * its description is not shipped in the per-request index (53 skills: 4124
 * tokens -> 61). The cost of that win is that the model is no longer nudged by
 * skill descriptions, so this plugin does the nudging: it reads the incoming
 * user message, filters the on-disk skill index for keyword matches, and appends
 * a one-line hint naming the best candidates. The model still chooses and loads
 * exactly one skill by id.
 *
 * Budget: ~40 tokens per user message, versus ~4124 tokens per request for the
 * full advertised index.
 *
 * Never throws - a plugin error must not break a session.
 */

const HOME = homedir()
const MARKER = "[skill-hint]"
const TTL_MS = 60_000
const MAX_HINT = 3

export type Skill = { id: string; name: string; desc: string; hidden: boolean }

let cache: { at: number; cwd: string; skills: Skill[] } | null = null

export function skillRoots(cwd: string): string[] {
  const roots: string[] = [
    join(HOME, ".config", "opencode", "skills"),
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
  "two","via","per","run","runs","running","and","or","to","of","in","on","at","is","it","be","do",
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

/** Token equality is too brittle after crude stemming ("brows" vs "browser"),
 *  so a query token also hits when it shares a >=4-char prefix with a hay token. */
function hits(q: string, hay: Set<string>): boolean {
  if (hay.has(q)) return true
  if (q.length < 4) return false
  for (const h of hay) {
    if (h.length >= 4 && (h.startsWith(q) || q.startsWith(h))) return true
  }
  return false
}

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

export const SkillHintPlugin: Plugin = async ({ directory }) => {
  return {
    "chat.message": async (_input, output) => {
      try {
        const parts = (output as any)?.parts
        if (!Array.isArray(parts)) return
        const part = parts.find((p: any) => p?.type === "text" && typeof p.text === "string")
        if (!part) return
        const raw: string = part.text
        const hint = hintFor(raw, directory)
        if (!hint) return
        part.text = raw + "\n\n" + hint
      } catch {
        // never break a session
      }
    },
  }
}
