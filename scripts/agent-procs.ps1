param([string]$Root)

# Enumerate QQ Agent's own node processes and classify them by command line.
# Ports flap while NapCat reconnects, so port-based lookup misses processes.
# Output: {"console":[pid...],"napcat":[pid...],"watch":[pid...]}
# English-only on purpose: the .ps1 is written without BOM, and PowerShell 5.1
# would read non-ASCII as ANSI and mangle it.

$exe = Join-Path $Root 'runtime\node.exe'
$result = @{ console = @(); napcat = @(); watch = @(); napcatStart = 0 }
$napcatStart = [datetime]::MinValue

$procs = $null
try {
    $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop
} catch {
    '{"console":[],"napcat":[],"watch":[]}'
    exit 0
}

foreach ($p in $procs) {
    if (-not $p.ExecutablePath) { continue }
    if ($p.ExecutablePath -ne $exe) { continue }

    $cl = ''
    if ($p.CommandLine) { $cl = $p.CommandLine }

    if ($cl -match 'watch-napcat') {
        $result.watch += [int]$p.ProcessId
    } elseif ($cl -match 'server\.js') {
        $result.console += [int]$p.ProcessId
    } elseif (($cl -match 'index-qq-local') -or ($cl -match 'napcat\.mjs') -or ($cl -match 'napcat\\shell')) {
        $result.napcat += [int]$p.ProcessId
        # The oldest one marks when this NapCat round started (launcher first, worker later)
        try {
            $ct = $p.CreationDate
            if ($ct -and $ct -lt $napcatStart) { $napcatStart = $ct }
        } catch { }
    }
}

if ($napcatStart -ne [datetime]::MinValue) {
    # epoch milliseconds, so the node side can subtract directly
    $result.napcatStart = [long]([datetimeoffset]$napcatStart).ToUnixTimeMilliseconds()
}

$result | ConvertTo-Json -Compress -Depth 3
