@echo off
setlocal
cd /d "%~dp0"
echo Stopping QQ Agent console (port 3210)...
set "FOUND="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":3210 .*LISTENING"') do (
  set "FOUND=1"
  echo   kill PID %%p
  taskkill /PID %%p /F >nul 2>&1
)
if defined FOUND (echo [OK] stopped) else (echo [INFO] nothing listening on 3210)
timeout /t 2 >nul
