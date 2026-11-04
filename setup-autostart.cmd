@echo off
setlocal
title Install autostart
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$dir=Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup';" ^
  "$lnk=Join-Path $dir 'QQ Agent.lnk';" ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($lnk);" ^
  "$s.TargetPath='%~dp0start-all.cmd';" ^
  "$s.WorkingDirectory='%~dp0';" ^
  "$s.WindowStyle=7;" ^
  "$s.Description='QQ Agent + NapCat';" ^
  "$s.Save();" ^
  "Write-Host ('[OK] ' + $lnk)"

if exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\QQ Agent.lnk" (
  echo.
  echo [DONE] QQ Agent will start automatically on next logon.
  echo        The NapCat window will show a QR code; scan it with the bot account.
  echo.
  echo To cancel: delete that .lnk in shell:startup
) else (
  echo [FAILED] Shortcut not created. Manual way: Win+R -^> shell:startup -^> drop a shortcut to start-all.cmd
)
echo.
pause
