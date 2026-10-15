import { candidates, hintFor, buildIndex, stem, tokens } from "../plugins/skill-hint.ts"

// Portable: the resolver always scans the global skill roots, so the working
// directory only adds project-level roots on top.
const cwd = process.cwd()

let fail = 0
const check = (name: string, cond: boolean, extra = "") => {
  console.log((cond ? "PASS  " : "FAIL  ") + name + (extra ? "   " + extra : ""))
  if (!cond) fail++
}

const index = buildIndex(cwd)
check("index builds", index.length > 20, `skills=${index.length}`)

const hiddenCount = index.filter((s) => s.hidden).length
check("hidden flags parsed", hiddenCount > 0, `hidden=${hiddenCount}/${index.length}`)

check("stem ies", stem("dependencies") === "dependency", stem("dependencies"))
check("stem ing", stem("debugging") === "debug", stem("debugging"))
check("stem s", stem("browsers") === "brows", stem("browsers"))
check("tokens drop stopwords", !tokens("the and for").length)

const c1 = candidates("review this diff for sql injection", cwd)
check("sql injection -> security-review", c1.includes("security-review"), JSON.stringify(c1))

const c2 = candidates("scrape prices from a site behind cloudflare", cwd)
check("scrape -> a browser skill", c2.some((x) => x.includes("browser")), JSON.stringify(c2))

const c3 = candidates("add a playwright test for the checkout flow", cwd)
check("playwright test -> testing skill", c3.some((x) => x.includes("test") || x.includes("playwright")), JSON.stringify(c3))

check("short text ignored", hintFor("hi", cwd) === null)
check("marker dedup", hintFor("review this diff\n\n[skill-hint] skill candidates: x", cwd) === null)

const h = hintFor("review this diff for sql injection", cwd)
check("hint is small", !!h && h.length < 400, `${h ? h.length : 0} chars`)

const noMatch = candidates("say hello to the team", cwd)
check("no false match on chit-chat", noMatch.length === 0, JSON.stringify(noMatch))

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
