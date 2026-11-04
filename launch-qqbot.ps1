# QQ 机器人 —— 统一控制面板（启动 / 停止 / 重启 / 状态）
# 由桌面快捷方式「QQ 机器人」→ start-qqbot.vbs 调用（隐藏启动，只显示这个窗口）
#
# 进程识别按「命令行」而不是端口：NapCat 有两个 node 进程（启动器 index-qq-local.js
# + 工作进程 napcat.mjs），端口在重连时会短暂消失，靠端口找会扑空。
$ErrorActionPreference = 'SilentlyContinue'

$root  = 'C:\Users\user\Documents\deepseek-harness\default-workspace\qq-agent'
$token = 'YOUR_WEBUI_TOKEN'
$lockFile = Join-Path $root 'data\napcat-watch.lock'
$nodeExe  = Join-Path $root 'runtime\node.exe'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:busy = $false
$script:refreshing = $false
$script:st = @{ console = $false; napcat = $false; watch = $false; online = $false }

# ── 探测 ──────────────────────────────────────────────────────────────
function Test-Port([int]$p) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect('127.0.0.1', $p, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(500)) { $c.Close(); return $false }
    $c.EndConnect($iar); $c.Close(); return $true
  } catch { return $false }
}

function Get-WatchPid {
  if (-not (Test-Path $lockFile)) { return 0 }
  try {
    $v = 0
    if ([int]::TryParse((Get-Content $lockFile -Raw).Trim(), [ref]$v)) {
      if ($v -gt 0 -and (Get-Process -Id $v -ErrorAction SilentlyContinue)) { return $v }
    }
  } catch { }
  return 0
}

function Get-NapcatOnline {
  try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/get_status' -Method Post -Body '{}' `
      -ContentType 'application/json' -TimeoutSec 2
    return ($r.data.online -eq $true)
  } catch { return $false }
}

# 只认本项目 runtime\node.exe 起的进程，再按命令行分类
function Get-AgentProcs {
  $r = @{ ok = $false; console = @(); napcat = @(); watch = @() }
  $procs = $null
  try { $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop }
  catch { return $r }
  $r.ok = $true
  foreach ($p in $procs) {
    $path = ''
    if ($p.ExecutablePath) { $path = $p.ExecutablePath }
    if ($path -ne $nodeExe) { continue }
    $cl = ''
    if ($p.CommandLine) { $cl = $p.CommandLine }
    if ($cl -match 'watch-napcat') { $r.watch += $p.ProcessId }
    elseif ($cl -match 'server\.js') { $r.console += $p.ProcessId }
    elseif (($cl -match 'index-qq-local') -or ($cl -match 'napcat\.mjs') -or ($cl -match 'napcat\\shell')) {
      $r.napcat += $p.ProcessId
    }
  }
  return $r
}

function Get-PidByPort([int]$port) {
  try {
    $out = & netstat -ano 2>$null
    foreach ($line in $out) {
      if ($line -notmatch 'LISTENING') { continue }
      if ($line -notmatch (':' + $port + '\s')) { continue }
      $cols = ($line.Trim() -split '\s+')
      $v = 0
      if ([int]::TryParse($cols[$cols.Length - 1], [ref]$v)) {
        if ($v -gt 0) { return $v }
      }
    }
  } catch { }
  return 0
}

# ── 窗口 ──────────────────────────────────────────────────────────────
$colorOn   = [System.Drawing.Color]::FromArgb(22, 163, 74)
$colorOff  = [System.Drawing.Color]::FromArgb(140, 145, 155)
$colorWarn = [System.Drawing.Color]::FromArgb(217, 119, 6)

$form = New-Object System.Windows.Forms.Form
$form.Text = 'QQ 机器人'
$form.ClientSize = New-Object System.Drawing.Size(600, 470)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(250, 250, 253)
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

$lblTitle = New-Object System.Windows.Forms.Label
$lblTitle.Text = 'QQ 机器人'
$lblTitle.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 17, [System.Drawing.FontStyle]::Bold)
$lblTitle.ForeColor = [System.Drawing.Color]::FromArgb(31, 78, 121)
$lblTitle.Location = New-Object System.Drawing.Point(22, 14)
$lblTitle.Size = New-Object System.Drawing.Size(300, 34)
$form.Controls.Add($lblTitle)

$lblSub = New-Object System.Windows.Forms.Label
$lblSub.Text = '一个窗口管全部：启动 / 停止 / 重启'
$lblSub.ForeColor = [System.Drawing.Color]::Gray
$lblSub.Location = New-Object System.Drawing.Point(24, 48)
$lblSub.Size = New-Object System.Drawing.Size(420, 18)
$form.Controls.Add($lblSub)

function New-StatusLabel([int]$y) {
  $l = New-Object System.Windows.Forms.Label
  $l.Location = New-Object System.Drawing.Point(24, $y)
  $l.Size = New-Object System.Drawing.Size(560, 22)
  $l.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)
  $l.ForeColor = $colorOff
  $l.Text = '● …'
  $form.Controls.Add($l)
  return $l
}

$lblConsole = New-StatusLabel 72
$lblNapcat  = New-StatusLabel 97
$lblWatch   = New-StatusLabel 122

$bar = New-Object System.Windows.Forms.ProgressBar
$bar.Location = New-Object System.Drawing.Point(24, 152)
$bar.Size = New-Object System.Drawing.Size(550, 16)
$bar.Minimum = 0
$bar.Maximum = 100
$bar.Value = 0
$form.Controls.Add($bar)

$log = New-Object System.Windows.Forms.TextBox
$log.Location = New-Object System.Drawing.Point(24, 178)
$log.Size = New-Object System.Drawing.Size(550, 212)
$log.Multiline = $true
$log.ReadOnly = $true
$log.ScrollBars = 'Vertical'
$log.BackColor = [System.Drawing.Color]::White
$log.Font = New-Object System.Drawing.Font('Consolas', 8.5)
$log.BorderStyle = 'FixedSingle'
$form.Controls.Add($log)

$lblHint = New-Object System.Windows.Forms.Label
$lblHint.Text = ''
$lblHint.ForeColor = [System.Drawing.Color]::Gray
$lblHint.Location = New-Object System.Drawing.Point(24, 396)
$lblHint.Size = New-Object System.Drawing.Size(400, 18)
$form.Controls.Add($lblHint)

function Write-Log([string]$t) {
  $log.AppendText(('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $t) + "`r`n")
  $log.SelectionStart = $log.Text.Length
  $log.ScrollToCaret()
  [System.Windows.Forms.Application]::DoEvents()
}

function Set-Bar([int]$pct) {
  if ($pct -lt 0) { $pct = 0 }
  if ($pct -gt 100) { $pct = 100 }
  $bar.Value = $pct
  [System.Windows.Forms.Application]::DoEvents()
}

function Set-Row($label, [string]$name, [string]$status, [string]$level) {
  if ($level -eq 'on') { $label.ForeColor = $colorOn }
  elseif ($level -eq 'warn') { $label.ForeColor = $colorWarn }
  else { $label.ForeColor = $colorOff }
  $label.Text = '● ' + $name + '    ' + $status
  [System.Windows.Forms.Application]::DoEvents()
}

function Wait-Port([int]$port, [int]$timeoutMs) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
    if (Test-Port $port) { return $true }
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Refresh-UI {
  if ($script:busy -or $script:refreshing) { return }
  $script:refreshing = $true
  try {
    $ap = Get-AgentProcs
    $watchAlive = ((Get-WatchPid) -gt 0) -or ($ap.watch.Count -gt 0)
    $consoleAlive = ($ap.console.Count -gt 0) -or (Test-Port 3210)
    $napcatAlive = ($ap.napcat.Count -gt 0) -or (Test-Port 6099) -or (Test-Port 3001)
    $online = Get-NapcatOnline

    $script:st.console = $consoleAlive
    $script:st.napcat = $napcatAlive
    $script:st.watch = $watchAlive
    $script:st.online = $online

    if ($consoleAlive) { Set-Row $lblConsole '控制台' '运行中（127.0.0.1:3210）' 'on' }
    else { Set-Row $lblConsole '控制台' '已停止' 'off' }

    if ($napcatAlive) {
      if ($online) { Set-Row $lblNapcat '协议端' ('运行中 · QQ 已在线（进程 ' + $ap.napcat.Count + ' 个）') 'on' }
      else { Set-Row $lblNapcat '协议端' '运行中 · 未登录（看护会自动重启）' 'warn' }
    } else { Set-Row $lblNapcat '协议端' '已停止' 'off' }

    if ($watchAlive) { Set-Row $lblWatch '掉线看护' '运行中（掉线自动重启）' 'on' }
    else { Set-Row $lblWatch '掉线看护' '已停止（掉线不会自动恢复）' 'off' }

    $anyOn = $consoleAlive -or $napcatAlive -or $watchAlive
    $btnStart.Enabled   = -not ($consoleAlive -and $napcatAlive -and $watchAlive)
    $btnStop.Enabled    = $anyOn
    $btnRestart.Enabled = $anyOn
    [System.Windows.Forms.Application]::DoEvents()
  } finally {
    $script:refreshing = $false
  }
}

# ── 启动 ──────────────────────────────────────────────────────────────
function Start-All {
  if ($script:busy) { return }
  $script:busy = $true
  $online = $false
  try {
    $ap = Get-AgentProcs
    Set-Bar 5

    if (($ap.console.Count -gt 0) -or (Test-Port 3210)) { Write-Log '控制台已经在运行（3210）' }
    else {
      Write-Log '启动控制台…'
      Start-Process -WindowStyle Hidden -FilePath $nodeExe `
        -ArgumentList @((Join-Path $root 'src\server.js')) -WorkingDirectory $root
    }
    Set-Bar 25

    if ($ap.napcat.Count -gt 0) { Write-Log ('协议端已经在运行（进程 ' + $ap.napcat.Count + ' 个）') }
    else {
      Write-Log '启动 QQ 协议端 NapCat…'
      # 走 VBS 以窗口样式 0 启动：直接 spawn cmd 会留一个可见黑窗口，
      # 而且会一直挂到 NapCat 退出（每次重启多一个窗口）。
      Start-Process -WindowStyle Hidden -FilePath 'wscript.exe' `
        -ArgumentList @('//nologo', (Join-Path $root 'bg-napcat-hidden.vbs'))
    }
    Set-Bar 45

    if ((Get-WatchPid) -gt 0 -or $ap.watch.Count -gt 0) { Write-Log '掉线看护已经在运行' }
    else {
      Write-Log '启动掉线看护…'
      Start-Process -WindowStyle Hidden -FilePath $nodeExe `
        -ArgumentList @((Join-Path $root 'watch-napcat.mjs')) -WorkingDirectory $root
    }
    Set-Bar 60

    Write-Log '等待控制台就绪…'
    if (Wait-Port 3210 20000) { Write-Log '控制台已就绪（3210）' }
    else { Write-Log '控制台 20 秒内没起来' }
    Set-Bar 75

    Write-Log '等待协议端就绪…'
    if (Wait-Port 3001 30000) { Write-Log '协议端已就绪（3001）' }
    else { Write-Log '协议端 30 秒内没就绪（可能要扫码）' }
    Set-Bar 88

    Write-Log '检查 QQ 登录状态…'
    for ($i = 0; $i -lt 12; $i++) {
      if (Get-NapcatOnline) { $online = $true; break }
      [System.Windows.Forms.Application]::DoEvents()
      Start-Sleep -Milliseconds 800
    }
    Set-Bar 100
  } finally {
    $script:busy = $false
  }

  Refresh-UI
  if ($online) {
    Write-Log '启动完成 —— QQ 已在线'
    Start-Process 'http://127.0.0.1:3210'
    for ($s = 8; $s -gt 0; $s--) {
      if (-not $form.Visible) { break }
      $lblHint.Text = "窗口将在 $s 秒后自动关闭"
      [System.Windows.Forms.Application]::DoEvents()
      Start-Sleep -Milliseconds 1000
    }
    if ($form.Visible) { $form.Close() }
  } else {
    Write-Log 'QQ 还没上线 —— 点「打开 WebUI」扫码，或等看护自动恢复'
    $lblHint.Text = '扫码完成后可以关闭本窗口'
  }
}

# ── 停止 ──────────────────────────────────────────────────────────────
function Kill-Pids($pids, [string]$name) {
  $n = 0
  foreach ($procId in $pids) {
    if ($procId -and $procId -gt 0) {
      & taskkill /F /T /PID $procId 2>&1 | Out-Null
      $n += 1
    }
  }
  if ($n -gt 0) { Write-Log ('结束 ' + $name + '（' + $n + ' 个进程）') }
  return $n
}

function Kill-PortFallback([int]$port, [string]$name) {
  $procId = Get-PidByPort $port
  if ($procId -gt 0) {
    & taskkill /F /T /PID $procId 2>&1 | Out-Null
    Write-Log ('按端口结束 ' + $name + '（端口 ' + $port + '，PID ' + $procId + '）')
    return $true
  }
  return $false
}

function Stop-All {
  if ($script:busy) { return }
  $script:busy = $true
  try {
    Set-Bar 10
    $ap = Get-AgentProcs

    # 1) 先停看护，否则它会把刚停掉的 NapCat 又拉起来
    $wpid = Get-WatchPid
    $watchList = @()
    if ($wpid -gt 0) { $watchList += $wpid }
    foreach ($procId in $ap.watch) { if ($watchList -notcontains $procId) { $watchList += $procId } }
    if ((Kill-Pids $watchList '掉线看护') -eq 0) { Write-Log '掉线看护没在运行' }
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
    Set-Bar 40

    # 2) 协议端：启动器 + 工作进程（按命令行识别；识别不到再按端口兜底）
    if ((Kill-Pids $ap.napcat '协议端') -eq 0) {
      $ok = Kill-PortFallback 6099 '协议端'
      if (-not $ok) { $ok = Kill-PortFallback 3001 '协议端' }
      if (-not $ok) { $ok = Kill-PortFallback 3000 '协议端' }
      if (-not $ok) { Write-Log '协议端没在运行' }
    }
    Set-Bar 70

    # 3) 控制台
    if ((Kill-Pids $ap.console '控制台') -eq 0) {
      if (-not (Kill-PortFallback 3210 '控制台')) { Write-Log '控制台没在运行' }
    }
    Set-Bar 100
    Start-Sleep -Milliseconds 800
  } finally {
    $script:busy = $false
  }

  Refresh-UI
  Write-Log '已全部停止'
  $lblHint.Text = '已停止 —— 点「启动全部」可以重新拉起'
}

# ── 按钮 ──────────────────────────────────────────────────────────────
function New-Btn([string]$text, [int]$x, [int]$w, $onClick) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.Location = New-Object System.Drawing.Point($x, 422)
  $b.Size = New-Object System.Drawing.Size($w, 32)
  $b.Add_Click($onClick)
  $form.Controls.Add($b)
  return $b
}

$btnStart   = New-Btn '启动全部'   24 100 { Set-Bar 0; Start-All }
$btnStop    = New-Btn '停止全部'  132 100 { Stop-All }
$btnRestart = New-Btn '重启'      240  80 { Stop-All; Start-Sleep -Milliseconds 1200; Start-All }
$btnConsole = New-Btn '打开控制台' 330 100 { Start-Process 'http://127.0.0.1:3210' }
$btnWebui   = New-Btn '打开 WebUI' 438  90 { Start-Process ('http://127.0.0.1:6099/webui?token=' + $token) }
$btnClose   = New-Btn '关闭'      536  38 { $form.Close() }

$form.Add_Shown({
  $form.Activate()
  Write-Log '检查当前状态…'
  Refresh-UI

  $allStopped = (-not $script:st.console) -and (-not $script:st.napcat) -and (-not $script:st.watch)
  if ($allStopped) {
    Write-Log '三个组件都没在运行，自动开始启动'
    Start-All
  } else {
    Write-Log '检测到已在运行 —— 可以用「停止全部」「重启」'
    $lblHint.Text = '状态每 3 秒自动刷新'
  }
})

$form.Show()

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({ Refresh-UI })
$timer.Start()

[System.Windows.Forms.Application]::DoEvents()
while ($form.Visible) {
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 60
}
