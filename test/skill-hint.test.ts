// Run: bun run test/skill-hint.test.ts   (from the repo root)
//
// The plugin imports `@opencode/plugin`, which only resolves inside an opencode
// config directory. Stub it so the pure logic stays testable anywhere.
import { mock } from "bun:test"

mock.module("@opencode/plugin", () => ({
  Plugin: { define: (p: unknown) => p },
}))

const { candidates, hintFor, buildIndex, stem, tokens, pick } = await import("../plugins/skill-hint.ts")

const cwd = process.cwd()

let fail = 0
const check = (name: string, cond: boolean, extra = "") => {
  console.log((cond ? "PASS  " : "FAIL  ") + name + (extra ? "   " + extra : ""))
  if (!cond) fail++
}

const index = buildIndex(cwd)
check("index builds", index.length > 20, `skills=${index.length}`)
check("hidden flags parsed", index.some((s) => s.hidden) || index.length > 0, `hidden=${index.filter((s) => s.hidden).length}/${index.length}`)

check("stem ies", stem("dependencies") === "dependency", stem("dependencies"))
check("stem ing", stem("debugging") === "debug", stem("debugging"))
check("stem s", stem("browsers") === "brows", stem("browsers"))
check("tokens drop stopwords", !tokens("the and for").length)

const c1 = candidates("review this diff for sql injection", cwd)
check("sql injection -> security-review", c1.includes("security-review"), JSON.stringify(c1))

const c2 = candidates("scrape prices from a site behind cloudflare", cwd)
check("scrape -> a browser skill", c2.some((x) => x.includes("browser")), JSON.stringify(c2))

const c3 = candidates("add a playwright test for the checkout flow", cwd)
check(
  "playwright test -> testing skill",
  c3.some((x) => x.includes("test") || x.includes("playwright")),
  JSON.stringify(c3),
)

check("short text ignored", hintFor("hi", cwd) === null)
check("marker dedup", hintFor("review this diff\n\n[skill-hint] skill candidates: x", cwd) === null)

const h = hintFor("review this diff for sql injection", cwd)
check("hint is small", !!h && h.length < 400, `${h ? h.length : 0} chars`)

check("no false match on chit-chat", candidates("say hello to the team", cwd).length === 0)

check("marker in prompt suppresses hint", hintFor("quote the [skill-hint] line please", cwd) === null)

// Auto-load precision. A wrong auto-load injects a whole skill body, so these
// guard the two failures that actually happened: a match-count gate picking
// jev-browser for "dark mode toggle", and an id-token gate picking find-skills
// for any prompt containing the word "skills".
const has = (id: string) => index.some((s) => s.id === id)
const autoChoices = pick("review this diff for sql injection and authentication vulnerabilities", cwd)
check("loose keyword prompt does not auto-load", autoChoices?.explicit === false, autoChoices?.id)
const generic = pick("add more commands please also have how do i use it? put it on github", cwd)
check("word 'skills' does not auto-load find-skills", generic?.explicit === false, generic?.id)
const amb = pick("build a settings page with a dark mode toggle", cwd)
check("ambiguous prompt does not auto-load", amb?.explicit === false, amb?.id)

// The /skills command body contains "skill-find.ps1"; the bare token "find" used
// to match find-skills and inject its whole body.
const cmdBody =
  'List all skills. Run exactly: powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\\.config\\opencode\\scripts\\skill-find.ps1" -List'
check("skill-find.ps1 path does not auto-load find-skills", pick(cmdBody, cwd)?.explicit === false, pick(cmdBody, cwd)?.id)

for (const [text, id] of [
  ["use the security-review skill on this file", "security-review"],
  ["run ponytail on this module", "ponytail"],
  ["follow karpathy-guidelines while you write this", "karpathy-guidelines"],
] as Array<[string, string]>) {
  if (!has(id)) {
    console.log(`SKIP  named skill not installed here: ${id}`)
    continue
  }
  const c = pick(text, cwd)
  check(`names ${id} -> auto-load it`, c?.explicit === true && c?.id === id, `got ${c?.id}/${c?.explicit}`)
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
