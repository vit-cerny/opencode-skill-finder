<#
  skill-find.ps1 - on-demand skill discovery for opencode.

  Problem: every advertised skill's description is injected into EVERY request.
  Taking stock of this machine on 2026-10-15: 53 skills ~= 4.1k tokens of
  always-on index, most of it unused most of the time.

  Fix: hide skills from the model's advertised list (frontmatter
  `disable-model-invocation: true`) and advertise exactly one tiny finder
  skill. Resolve the right skill at task time with this script. Hidden skills
  stay registered and loadable by id - they are just not shipped in every prompt.

  Usage:
    skill-find.ps1 -Task "add a playwright test for the checkout flow"
    skill-find.ps1 -Task "..." -Top 3
    skill-find.ps1 -List                       # compact index of every skill
    skill-find.ps1 -Use web-design-engineer -Task "build a dashboard"
    skill-find.ps1 -Promote -Threshold 5       # hot skills become always-advertised
    skill-find.ps1 -Demote web-design-engineer
    skill-find.ps1 -Enable                     # hide all, keep the finder. idempotent
    skill-find.ps1 -Restore                    # undo -Enable
    skill-find.ps1 -Status
    skill-find.ps1 -Task "..." -Online         # also query the skills.sh catalog

  ASCII only. PowerShell 5.1. No dependencies.
#>
[CmdletBinding()]
param(
  [string]$Task = "",
  [int]$Top = 3,
  [switch]$List,
  [switch]$Commands,
  [string]$Use = "",
  [switch]$Enable,
  [switch]$Restore,
  [switch]$Promote,
  [int]$Threshold = 5,
  [string]$Demote = "",
  [switch]$Status,
  [switch]$Online,
  [switch]$Rebuild
)

$ErrorActionPreference = "Stop"
$Inv = [System.Globalization.CultureInfo]::InvariantCulture
# PS 5.1 `Set-Content -Encoding UTF8` writes a BOM, which breaks `---` frontmatter
# parsing. All skill-file writes go through this instead.
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$ConfigRoot = Join-Path $env:USERPROFILE ".config\opencode"
$StateFile  = Join-Path $ConfigRoot "skill-finder-state.json"
$UsageFile  = Join-Path $ConfigRoot "skill-usage.jsonl"
$IndexFile  = Join-Path $ConfigRoot "skill-index.json"
$FinderId   = "skill-finder"

# Scan order: first root that defines a name wins (matches opencode's behaviour).
function Get-SkillRoots {
  $cwd = (Get-Location).Path
  $roots = @()
  $roots += (Join-Path $ConfigRoot "skills")                      # global
  $roots += (Join-Path $env:USERPROFILE ".claude\skills")         # global compat
  $roots += (Join-Path $env:USERPROFILE ".agents\skills")         # global compat
  foreach ($d in @($cwd, (Split-Path $cwd -Parent))) {
    $roots += (Join-Path $d ".opencode\skills")
    $roots += (Join-Path $d ".claude\skills")
    $roots += (Join-Path $d ".agents\skills")
  }
  return ($roots | Where-Object { Test-Path $_ -PathType Container } | Select-Object -Unique)
}

# Read only the frontmatter, never the whole body (bodies reach 26 KB).
function Read-SkillFront {
  param([string]$Path)
  $out = [ordered]@{ name = ""; description = ""; hidden = $false }
  $lines = Get-Content $Path -TotalCount 60 -Encoding UTF8
  if (-not $lines) { return $out }
  if ($lines[0].Trim() -ne "---") { return $out }
  for ($i = 1; $i -lt $lines.Count; $i++) {
    $l = $lines[$i]
    if ($l.Trim() -eq "---") { break }
    if ($l -match '^\s*disable-model-invocation:\s*true') { $out.hidden = $true; continue }
    if ($l -match '^\s*opencode/autoinvoke:\s*false')     { $out.hidden = $true; continue }
    if ($l -match '^\s*autoinvoke:\s*false')              { $out.hidden = $true; continue }
    if ($l -match '^\s*name:\s*(.+)$' -and -not $out.name) {
      $out.name = ($Matches[1] -replace '^["'']|["'']$', '').Trim(); continue
    }
    if ($l -match '^\s*description:\s*(.*)$' -and -not $out.description) {
      $v = $Matches[1].Trim()
      if ($v -eq "" -or $v -match '^[>|][-+]?$') {
        $buf = @()
        for ($k = $i + 1; $k -lt $lines.Count; $k++) {
          $nx = $lines[$k]
          if ($nx.Trim() -eq "---") { break }
          if ($nx -match '^\S') { break }
          if ($nx.Trim() -ne "") { $buf += $nx.Trim() }
        }
        $out.description = ($buf -join " ")
      } else {
        $out.description = ($v -replace '^["'']|["'']$', '').Trim()
      }
    }
  }
  return $out
}

function Get-SkillIndex {
  $seen = @{}
  $items = @()
  foreach ($root in Get-SkillRoots) {
    Get-ChildItem $root -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
      $id = $_.Name
      if ($seen.ContainsKey($id)) { return }
      $f = Join-Path $_.FullName "SKILL.md"
      if (-not (Test-Path $f)) { return }
      $seen[$id] = $true
      $front = Read-SkillFront -Path $f
      $items += [PSCustomObject]@{
        id     = $id
        name   = $(if ($front.name) { $front.name } else { $id })
        desc   = $front.description
        path   = $f
        hidden = $front.hidden
        bytes  = (Get-Item $f).Length
      }
    }
  }
  return @($items | Sort-Object id)
}

$Stop = @("the","and","for","with","that","this","from","into","your","you","are","was","were",
"have","has","had","not","but","all","any","can","will","would","should","could","when","then",
"than","them","they","their","there","here","its","our","out","use","using","used","make","makes",
"made","get","gets","got","new","add","adds","added","need","needs","want","wants","please","help",
"how","what","why","does","doing","done","also","just","like","some","more","most","very","only",
"other","over","under","about","after","before","while","where","which","who","whom","file","files",
"code","work","task","thing","want","let","lets","now","one","two","via","per","run","runs","running")

# Crude but effective suffix stripper. Handles the cases that actually matter here.
function Get-Stem {
  param([string]$W)
  if ($W.Length -lt 4) { return $W }
  foreach ($suf in @("ations","ation","ings","ing","ies","ied","ers","ed","es","s","ly")) {
    if ($W.EndsWith($suf) -and ($W.Length - $suf.Length) -ge 3) {
      $base = $W.Substring(0, $W.Length - $suf.Length)
      if ($suf -eq "ies") { return $base + "y" }
      if ($suf -eq "ing" -or $suf -eq "ed") {
        if ($base.Length -ge 2 -and $base[-1] -eq $base[-2]) { $base = $base.Substring(0, $base.Length - 1) }
      }
      return $base
    }
  }
  return $W
}

function Get-Tokens {
  param([string]$Text)
  if (-not $Text) { return @() }
  $t = ($Text.ToLower() -replace '[^a-z0-9]+', ' ').Split(' ')
  $out = @()
  foreach ($w in $t) {
    if ($w.Length -lt 3 -or $Stop -contains $w) { continue }
    $out += (Get-Stem $w)
  }
  return ($out | Select-Object -Unique)
}

# Live truth from the running server (includes built-ins like /init and /review).
# Falls back to a disk scan when the server is not reachable.
function Show-Commands {
  $live = $null
  try {
    $raw = (opencode api GET /api/command 2>$null | Out-String)
    if ($raw -and $raw.Trim().StartsWith("{")) { $live = @((($raw | ConvertFrom-Json).data)) }
  } catch { $live = $null }

  if ($live -and $live.Count -gt 0) {
    Write-Output ("commands ({0}, live):" -f $live.Count)
    foreach ($c in ($live | Sort-Object name)) {
      $d = "$($c.description)"
      if ($d.Length -gt 68) { $d = $d.Substring(0, 65) + "..." }
      Write-Output ("  /{0,-28} {1}" -f $c.name, $d)
    }
    Write-Output ""
    Write-Output "custom command files: $ConfigRoot\commands  (+ <project>\.opencode\commands)"
    return
  }

  Write-Output "commands (from disk - server not reachable):"
  $dirs = @((Join-Path $ConfigRoot "commands"), (Join-Path (Get-Location).Path ".opencode\commands"))
  foreach ($d in $dirs) {
    if (-not (Test-Path $d)) { continue }
    Write-Output ("  [{0}]" -f $d)
    Get-ChildItem $d -Filter *.md -ErrorAction SilentlyContinue | ForEach-Object {
      $fm = Get-Content $_.FullName -TotalCount 8 -Encoding UTF8
      $desc = ($fm | Where-Object { $_ -match '^description:' } | Select-Object -First 1)
      $desc = if ($desc) { ($desc -replace '^description:\s*', '').Trim() } else { "" }
      if ($desc.Length -gt 60) { $desc = $desc.Substring(0, 57) + "..." }
      Write-Output ("  /{0,-28} {1}" -f $_.BaseName, $desc)
    }
  }
}

function Show-One {
  param($R)
  $d = $R.desc
  if ($d.Length -gt 200) { $d = $d.Substring(0, 197) + "..." }
  Write-Output ("id: {0}   advertised: {1}" -f $R.id, $(if ($R.hidden) { "no (hidden)" } else { "yes" }))
  Write-Output ("  load : skill tool, id ""{0}""   (fallback: read the path)" -f $R.id)
  Write-Output ("  path : {0}" -f $R.path)
  Write-Output ("  desc : {0}" -f $d)
  Write-Output ""
}

function Show-Compact {
  param($Index, [int]$Max = 70)
  $all = @($Index | Sort-Object id)
  $shown = @($all | Select-Object -First $Max)
  foreach ($s in $shown) {
    $d = $s.desc
    if ($d.Length -gt 74) { $d = $d.Substring(0, 71) + "..." }
    Write-Output ("  {0,-30} {1}" -f $s.id, $d)
  }
  if ($all.Count -gt $shown.Count) {
    Write-Output ("  ... and {0} more (raise -Max or read {1})" -f ($all.Count - $shown.Count), $IndexFile)
  }
  Write-Output ""
}

# Honest matching: a keyword has to actually appear in the id, name or description.
# Anything else is guesswork over marketing prose, so we do not pretend to rank it.
# No match -> hand the model the compact index and let it choose (the best matcher
# available is the model already in the conversation).
# Token equality is too brittle after crude stemming ("brows" vs "browser"),
# so a query token also hits when it shares a >=4-char prefix with a hay token.
function Test-Hit {
  param([string]$Q, $Hay)
  if ($Hay -contains $Q) { return $true }
  if ($Q.Length -lt 4) { return $false }
  foreach ($h in $Hay) {
    if ($h.Length -ge 4 -and ($h.StartsWith($Q) -or $Q.StartsWith($h))) { return $true }
  }
  return $false
}

function Invoke-Find {
  param([string]$Query, [int]$Count)
  $index = Get-SkillIndex
  $qTokens = Get-Tokens $Query
  $hits = @()
  if ($qTokens.Count -gt 0) {
    foreach ($s in $index) {
      $hay = Get-Tokens ("$($s.id) $($s.name) $($s.desc)")
      $m = 0
      foreach ($t in $qTokens) { if (Test-Hit -Q $t -Hay $hay) { $m++ } }
      if ($m -gt 0) { $hits += [PSCustomObject]@{ s = $s; m = $m } }
    }
    $hits = @($hits | Sort-Object -Property @{ Expression = { $_.m }; Descending = $true }, @{ Expression = { $_.s.id } } | Select-Object -First $Count)
  }

  if ($hits.Count -eq 0) {
    Write-Output "no skill name or description contains those words. choose from the full index:"
    Write-Output ""
    Show-Compact -Index $index
    return
  }

  Write-Output "keyword matches - load one by id (the model picks; the script only filters):"
  Write-Output ""
  foreach ($h in $hits) { Show-One -R $h.s }
  Write-Output "none fit? full index: -List      after loading: -Use <id> -Task ""<task>"""
}

function Write-Index {
  $index = Get-SkillIndex
  $adv = @($index | Where-Object { -not $_.hidden })
  $hid = @($index | Where-Object { $_.hidden })
  $a = ($adv | ForEach-Object { $_.desc.Length } | Measure-Object -Sum).Sum; if (-not $a) { $a = 0 }
  $h = ($hid | ForEach-Object { $_.desc.Length } | Measure-Object -Sum).Sum; if (-not $h) { $h = 0 }
  $payload = [PSCustomObject]@{
    builtAt         = (Get-Date).ToString("s")
    cwd             = (Get-Location).Path
    roots           = @(Get-SkillRoots)
    advertisedChars = $a
    hiddenChars     = $h
    skills          = $index
  }
  $payload | ConvertTo-Json -Depth 4 | Set-Content -Path $IndexFile -Encoding UTF8
  return $index
}

function Set-Hidden {
  param($Index, [bool]$Hide)
  if (-not (Test-Path $StateFile)) {
    [PSCustomObject]@{ edited = @(); promoted = @() } | ConvertTo-Json | Set-Content $StateFile -Encoding UTF8
  }
  $state = Get-Content $StateFile -Raw | ConvertFrom-Json
  $edited = @(); if ($state.edited) { $edited = @($state.edited) }
  $changed = 0; $skipped = 0
  foreach ($s in $Index) {
    if ($s.id -eq $FinderId) { $skipped++; continue }
    $raw = [System.IO.File]::ReadAllText($s.path)
    if ($Hide) {
      if ($raw -match '(?m)^disable-model-invocation:[ \t]*true[ \t]*\r?$') { continue }
      $m = [regex]::Match($raw, '\A---(\r?\n)')
      if (-not $m.Success) { continue }
      # reuse the file's own line ending so Restore is byte-identical
      $nl = $m.Groups[1].Value
      $new = "---" + $nl + "disable-model-invocation: true" + $nl + $raw.Substring($m.Length)
      [System.IO.File]::WriteAllText($s.path, $new, $Utf8NoBom)
      if ($edited -notcontains $s.path) { $edited += $s.path }
      $changed++
    } else {
      if ($raw -match '(?m)^disable-model-invocation:[ \t]*true[ \t]*\r?\n') {
        $new = [regex]::Replace($raw, '(?m)^disable-model-invocation:[ \t]*true[ \t]*\r?\n', '', 1)
        [System.IO.File]::WriteAllText($s.path, $new, $Utf8NoBom)
        $changed++
      }
      $edited = @($edited | Where-Object { $_ -ne $s.path })
    }
  }
  $state.edited = $edited
  $state | ConvertTo-Json -Depth 4 | Set-Content $StateFile -Encoding UTF8
  if ($Hide) { Write-Output "hid $changed skill(s); $skipped skipped (finder stays advertised)" }
  else       { Write-Output "restored $changed skill(s)" }
}

function Get-UsageCounts {
  $c = @{}
  if (-not (Test-Path $UsageFile)) { return $c }
  Get-Content $UsageFile -Encoding UTF8 | ForEach-Object {
    if (-not $_) { return }
    try { $o = $_ | ConvertFrom-Json } catch { return }
    if (-not $o.id) { return }
    if ($c.ContainsKey($o.id)) { $c[$o.id]++ } else { $c[$o.id] = 1 }
  }
  return $c
}

function Invoke-Promote {
  param([int]$Min)
  $counts = Get-UsageCounts
  if ($counts.Count -eq 0) { Write-Output "no usage recorded yet ($UsageFile)"; return }
  $index = Get-SkillIndex
  $state = Get-Content $StateFile -Raw | ConvertFrom-Json
  $promoted = @($state.promoted)
  $did = @()
  foreach ($k in $counts.Keys) {
    if ($counts[$k] -lt $Min) { continue }
    $s = $index | Where-Object { $_.id -eq $k } | Select-Object -First 1
    if (-not $s -or -not $s.hidden) { continue }
    $raw = [System.IO.File]::ReadAllText($s.path)
    $new = [regex]::Replace($raw, '(?m)^\s*disable-model-invocation:\s*true\s*\r?\n', '', 1)
    [System.IO.File]::WriteAllText($s.path, $new, $Utf8NoBom)
    if ($promoted -notcontains $k) { $promoted += $k }
    $did += ("{0} ({1} uses)" -f $k, $counts[$k])
  }
  $state.promoted = $promoted
  $state | ConvertTo-Json -Depth 4 | Set-Content $StateFile -Encoding UTF8
  if ($did) { Write-Output "promoted to always-advertised:"; $did | ForEach-Object { "  $_" } }
  else { Write-Output "nothing reached $Min uses yet" }
}

function Invoke-Status {
  $index = Write-Index
  $adv = @($index | Where-Object { -not $_.hidden })
  $hid = @($index | Where-Object { $_.hidden })
  $a = ($adv | ForEach-Object { $_.desc.Length } | Measure-Object -Sum).Sum; if (-not $a) { $a = 0 }
  $h = ($hid | ForEach-Object { $_.desc.Length } | Measure-Object -Sum).Sum; if (-not $h) { $h = 0 }
  Write-Output ("skills on disk     : {0}" -f $index.Count)
  Write-Output ("advertised (costs) : {0}  ->  {1} chars  ~{2} tokens per request" -f $adv.Count, $a, [int]($a / 4))
  Write-Output ("hidden (free)      : {0}  ->  would cost ~{1} tokens if all advertised" -f $hid.Count, [int](($a + $h) / 4))
  Write-Output ("index file         : {0}" -f $IndexFile)
  $counts = Get-UsageCounts
  if ($counts.Count -gt 0) {
    Write-Output "top usage:"
    $counts.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 8 | ForEach-Object { "  {0,-30} {1}" -f $_.Key, $_.Value }
  }
  Write-Output "still advertised:"
  $adv | ForEach-Object { "  {0}" -f $_.id }
}

function Invoke-Online {
  param([string]$Query)
  # skills.sh search needs a Vercel OIDC token; without one the call is a 401.
  # Report that plainly rather than pretending discovery worked.
  $token = $env:VERCEL_OIDC_TOKEN
  $uri = "https://skills.sh/api/v1/skills/search?q=" + [uri]::EscapeDataString($Query) + "&limit=5"
  $headers = @{}
  if ($token) { $headers["Authorization"] = "Bearer $token" }
  try {
    $r = Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 25 -ErrorAction Stop
    Write-Output ("catalog hits ({0}):" -f $r.searchType)
    foreach ($hit in $r.data) { Write-Output ("  {0,-46} {1,8} installs" -f $hit.id, $hit.installs) }
    Write-Output "install one:  npx skills add <owner/repo>"
  } catch {
    $code = ""
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    if ($code -eq 401) {
      Write-Output "skills.sh catalog: 401 - the API needs a Vercel OIDC token."
      Write-Output "install from the catalog by repo instead:  npx skills add <owner/repo>"
      Write-Output "docs: https://www.skills.sh/docs/cli"
    } else {
      Write-Output ("skills.sh catalog unavailable ({0}): {1}" -f $code, $_.Exception.Message)
    }
  }
}

# ---- dispatch ----
if ($Enable)  { Set-Hidden -Index (Get-SkillIndex) -Hide $true;  Write-Index | Out-Null; exit 0 }
if ($Restore) { Set-Hidden -Index (Get-SkillIndex) -Hide $false; Write-Index | Out-Null; exit 0 }
if ($Promote) { Invoke-Promote -Min $Threshold; Write-Index | Out-Null; exit 0 }
if ($Demote) {
  $s = (Get-SkillIndex) | Where-Object { $_.id -eq $Demote } | Select-Object -First 1
  if (-not $s) { Write-Output "unknown skill: $Demote"; exit 1 }
  Set-Hidden -Index @($s) -Hide $true
  $st = Get-Content $StateFile -Raw | ConvertFrom-Json
  $st.promoted = @($st.promoted | Where-Object { $_ -ne $Demote })
  $st | ConvertTo-Json -Depth 4 | Set-Content $StateFile -Encoding UTF8
  Write-Index | Out-Null; exit 0
}
if ($Status -or $Rebuild) { Invoke-Status; exit 0 }
if ($Commands) { Show-Commands; exit 0 }
if ($List) { Write-Index | Out-Null; Write-Output "all skills on disk:"; Show-Compact -Index (Get-SkillIndex); exit 0 }
if ($Use) {
  if (-not ((Get-SkillIndex) | Where-Object { $_.id -eq $Use })) { Write-Output "unknown skill: $Use"; exit 1 }
  $rec = [PSCustomObject]@{ ts = (Get-Date).ToString("s"); id = $Use; task = $Task; cwd = (Get-Location).Path }
  Add-Content -Path $UsageFile -Value ($rec | ConvertTo-Json -Compress) -Encoding UTF8
  Write-Output "recorded: $Use"
  Write-Output ("total uses: {0}" -f (Get-UsageCounts)[$Use])
  exit 0
}
if ($Task) {
  Invoke-Find -Query $Task -Count $Top
  if ($Online) { Write-Output ""; Invoke-Online -Query $Task }
  Write-Index | Out-Null
  exit 0
}

Get-Help $MyInvocation.MyCommand.Path -Detailed
