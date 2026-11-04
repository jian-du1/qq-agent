#requires -Version 5.1
<#
  align-device-id.ps1  (v2, 2026-11-02)

  WHAT IT DOES
    Reads the device GUID the QQ core actually uses
      <Documents>\Tencent Files\nt_qq\global\nt_data\msf\Registry20
    and makes NapCat's own copy carry the same value through NapCat's WebUI API:
      POST /api/QQLogin/SetDeviceGUID { guid }
    then verifies with POST /api/QQLogin/GetDeviceGUID.

  WHY THE API (and not direct file writes)
    - QQ core data path (global) = C:\Users\<u>\Documents\Tencent Files (read-only for us)
    - NapCat data path = <qq-agent>\napcat\qqdata   (moved here by NAPCAT_DATA_OVERRIDE)
    - The qqdata msf folder carries an explicit DENY ACE for Everyone (=delete child),
      so a non-elevated/restricted shell cannot copy or create files there, and an
      in-place write to Registry20 is denied as well.
    - NapCat's own process can write it, and its API writes the correct format,
      including an automatic Registry20.bak.<timestamp> next to the file.

  FILE FORMAT (from napcat.mjs, class ms / class oi)
    plain  = DPAPI(CurrentUser).Unprotect(file)          ; 20 bytes
    prefix = 00 00 00 14
    guid   = plain[4..19] , byte = ~(stored ^ 0x10) & 0xFF
    machine-info is a separate file: [uint32be len][ascii mac], mac = xx-xx-xx-xx-xx-xx
    (NOT touched by this script: rewriting a fake MAC changes the client fingerprint
     and can itself trigger a "new device" verification.)

  USAGE
    powershell -NoProfile -ExecutionPolicy Bypass -File align-device-id.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File align-device-id.ps1 -DryRun
    powershell -NoProfile -ExecutionPolicy Bypass -File align-device-id.ps1 -Guid <32hex> -Port 6099
#>
param(
  [string]$Guid = '',
  [string]$Port = '6099',
  [string]$Token = 'YOUR_WEBUI_TOKEN',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

function Read-CoreGuid() {
  $p = Join-Path $env:USERPROFILE 'Documents\Tencent Files\nt_qq\global\nt_data\msf\Registry20'
  if (-not (Test-Path -LiteralPath $p)) { throw "core Registry20 not found: $p" }
  $blob = [System.IO.File]::ReadAllBytes($p)
  $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, 'CurrentUser')
  if ($plain.Length -lt 20) { throw "decrypted too short: $($plain.Length)" }
  $sb = New-Object System.Text.StringBuilder
  for ($i = 4; $i -lt 20; $i++) {
    [void]$sb.Append((((-bnot ($plain[$i] -bxor 0x10)) -band 255)).ToString('x2'))
  }
  return $sb.ToString()
}

function Get-ApiCredential([string]$base, [string]$token) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $hash = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($token + '.napcat')) | ForEach-Object { $_.ToString('x2') })
  $r = Invoke-RestMethod -Uri "$base/api/auth/login" -Method Post -ContentType 'application/json' `
       -Body (@{ hash = $hash } | ConvertTo-Json -Compress)
  if ($r.code -ne 0) { throw "auth failed: $($r.message)" }
  return $r.data.Credential
}

if (-not $Guid) { $Guid = Read-CoreGuid }
if ($Guid -notmatch '^[0-9a-fA-F]{32}$') { throw 'guid must be 32 hex chars' }
$Guid = $Guid.ToLower()

$base = "http://127.0.0.1:$Port"
"core guid (Documents) : $Guid"
"napcat webui          : $base"

$cred = Get-ApiCredential $base $Token
$h = @{ Authorization = "Bearer $cred" }

$cur = (Invoke-RestMethod -Uri "$base/api/QQLogin/GetDeviceGUID" -Headers $h -Method Post `
        -ContentType 'application/json' -Body '{}').data.guid
"napcat guid (before)  : $cur"

if ($cur -eq $Guid) {
  ""
  "already aligned, nothing to do."
  exit 0
}
if ($DryRun) {
  ""
  "dry run: would set $cur -> $Guid"
  exit 0
}

$set = Invoke-RestMethod -Uri "$base/api/QQLogin/SetDeviceGUID" -Headers $h -Method Post `
       -ContentType 'application/json' -Body (@{ guid = $Guid } | ConvertTo-Json -Compress)
if ($set.code -ne 0) { throw "SetDeviceGUID failed: $($set.message)" }

$after = (Invoke-RestMethod -Uri "$base/api/QQLogin/GetDeviceGUID" -Headers $h -Method Post `
          -ContentType 'application/json' -Body '{}').data.guid
"napcat guid (after)   : $after"
if ($after -ne $Guid) { throw "verify failed: got $after" }
""
"done. a Registry20.bak.<timestamp> was created automatically by NapCat."
"note: the Documents copy is never written by this script - it is the live identity."
