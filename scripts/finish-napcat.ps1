# 收尾 NapCat：从已安装的 QQ 里补上 ssl.dll / crypto.dll，然后校验 NapCat 内核可加载
# 用法： powershell -ExecutionPolicy Bypass -File .\scripts\finish-napcat.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot          # qq-agent 根目录
$shell = Join-Path $root 'napcat\shell'
$runtime = Join-Path $root 'runtime\node.exe'
$node = if (Test-Path $runtime) { $runtime } else { 'node' }

Write-Host '== 1. 找 QQ 安装目录 ==' -ForegroundColor Cyan
$qqRoots = @(
  "$env:ProgramFiles\Tencent\QQNT",
  "${env:ProgramFiles(x86)}\Tencent\QQNT",
  "$env:LOCALAPPDATA\Programs\Tencent\QQNT"
) | Where-Object { Test-Path $_ }
if (-not $qqRoots) { throw '没找到 QQ 安装目录（C:\Program Files\Tencent\QQNT）' }

$dlls = foreach ($r in $qqRoots) {
  Get-ChildItem $r -Recurse -File -Include ssl.dll, crypto.dll -ErrorAction SilentlyContinue
}
$ssl = $dlls | Where-Object Name -eq 'ssl.dll'    | Select-Object -First 1
$cry = $dlls | Where-Object Name -eq 'crypto.dll' | Select-Object -First 1

if (-not $ssl -or -not $cry) {
  Write-Host '未找到 ssl.dll / crypto.dll。' -ForegroundColor Yellow
  Write-Host '说明 QQ 还是 9.9.27 那一代；请先在 QQ 里「设置 → 关于 → 检查更新」升级到 9.9.32 以上。'
  exit 2
}
Write-Host ("  ssl.dll    <- " + $ssl.FullName)
Write-Host ("  crypto.dll <- " + $cry.FullName)

Write-Host '== 2. 复制到 NapCat 目录 ==' -ForegroundColor Cyan
Copy-Item $ssl.FullName  (Join-Path $shell 'ssl.dll')    -Force
Copy-Item $cry.FullName  (Join-Path $shell 'crypto.dll') -Force
Get-ChildItem $shell -Filter *.dll | Where-Object { $_.Name -in 'ssl.dll', 'crypto.dll' } |
  Select-Object Name, Length | Format-Table -AutoSize

Write-Host '== 3. 校验 wrapper.node 能否加载 ==' -ForegroundColor Cyan
$probe = Join-Path $env:TEMP 'probe-wrapper.cjs'
@'
const { pathToFileURL } = require('url');
try { process.dlopen({ exports: {} }, process.argv[2]); console.log('WRAPPER LOAD OK'); }
catch (e) { console.log('WRAPPER LOAD FAIL: ' + e.message); process.exitCode = 1; }
'@ | Set-Content -Path $probe -Encoding UTF8
Push-Location $shell
& $node $probe (Join-Path $shell 'wrapper.node')
$code = $LASTEXITCODE
Pop-Location
Remove-Item $probe -Force -ErrorAction SilentlyContinue

if ($code -eq 0) {
  Write-Host '✅ NapCat 内核可加载，接下来双击 start-napcat.cmd 启动协议端。' -ForegroundColor Green
} else {
  Write-Host '❌ 仍然加载失败，把上面的报错发给 DSH。' -ForegroundColor Red
}
exit $code
