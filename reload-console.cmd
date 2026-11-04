@echo off
rem Restart ONLY the console (3210). NapCat keeps running, so no QR scan needed.
setlocal
cd /d "%~dp0"

echo Stopping console on 3210...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":3210 .*LISTENING"') do (
  taskkill /PID %%p /F >nul 2>&1
)
timeout /t 2 >nul

echo Starting console (hidden)...
wscript "%~dp0run-agent.vbs"

timeout /t 6 >nul
netstat -ano | findstr /r /c:":3210 .*LISTENING" >nul
if errorlevel 1 (
  echo [FAILED] console did not come up. Run run-agent.vbs manually.
) else (
  echo [OK] console restarted on http://127.0.0.1:3210
)
timeout /t 2 >nul
