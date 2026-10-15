<#
  install.ps1 - copy skill-finder into the opencode global config.

  Idempotent. Copies four files, then hides every skill except the finder so the
  per-request index collapses to a single description. Run again after adding
  skills with `npx skills add`, or use `-NoEnable` to install without touching
  frontmatter.
#>
[CmdletBinding()]
param(
  [string]$ConfigRoot = (Join-Path $env:USERPROFILE ".config\opencode"),
  [switch]$NoEnable
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$targets = @(
  @{ src = "skills\skill-finder\SKILL.md"; dst = "skills\skill-finder\SKILL.md" },
  @{ src = "commands\skillfinder.md";      dst = "commands\skillfinder.md" },
  @{ src = "scripts\skill-find.ps1";       dst = "scripts\skill-find.ps1" },
  @{ src = "plugins\skill-hint.ts";        dst = "plugins\skill-hint.ts" }
)

foreach ($t in $targets) {
  $s = Join-Path $here $t.src
  $d = Join-Path $ConfigRoot $t.dst
  if (-not (Test-Path $s)) { Write-Output "missing source: $s"; exit 1 }
  $dir = Split-Path -Parent $d
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  Copy-Item $s $d -Force
  Write-Output "installed $($t.dst)"
}

$script = Join-Path $ConfigRoot "scripts\skill-find.ps1"

if ($NoEnable) {
  Write-Output ""
  Write-Output "installed without hiding skills. run:"
  Write-Output "  powershell -NoProfile -ExecutionPolicy Bypass -File `"$script`" -Enable"
  exit 0
}

Write-Output ""
& powershell -NoProfile -ExecutionPolicy Bypass -File $script -Enable
Write-Output ""
& powershell -NoProfile -ExecutionPolicy Bypass -File $script -Status
Write-Output ""
Write-Output "restart opencode if the plugin does not appear in: opencode plugin list"
