@echo off
setlocal
cd /d "%~dp0"
echo Stopping NapCat (ports 6099 / 3000 / 3001)...
set "FOUND="
for %%P in (6099 3000 3001) do (
  for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%%P .*LISTENING"') do (
    set "FOUND=1"
    echo   kill PID %%p on port %%P
    taskkill /PID %%p /F >nul 2>&1
  )
)
if defined FOUND (echo [OK] stopped) else (echo [INFO] NapCat not running)
timeout /t 2 >nul
