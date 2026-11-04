@echo off
rem NapCat protocol service, hidden.
rem Guards against a duplicate instance (two NapCats fight over one QQ account):
rem   1) is a NapCat node process already alive?  (command line check)
rem   2) let a just-started instance bind its ports, then check them
rem NOTE: use ping, not timeout -- "timeout" returns instantly in a console-less
rem window (no input handle), which silently disabled the settle delay before.
rem ASCII-only on purpose: cmd.exe reads this file in the OEM codepage, so
rem Chinese comments would be decoded wrongly and break the batch parsing.
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*index-qq-local.js*' }) { exit 1 } else { exit 0 }"
if errorlevel 1 exit /b 0

ping -n 7 127.0.0.1 >nul

for %%P in (6099 6100 6101 6102 6103 6104 6105 3000 3001) do (
  netstat -ano | findstr /r /c:":%%P .*LISTENING" >nul
  if not errorlevel 1 exit /b 0
)

if not exist "runtime\node.exe" exit /b 1
if not exist "tmp" mkdir "tmp"
set "TEMP=%CD%\tmp"
set "TMP=%CD%\tmp"

rem QQ data inside the project: pointing it at Documents\Tencent Files makes the
rem worker hang right after login on this machine.
if not exist "napcat\qqdata" mkdir "napcat\qqdata"
set "NAPCAT_DATA_OVERRIDE=%CD%\napcat\qqdata"

rem Password fallback is OFF on purpose (2026-11-02). Keep ACCOUNT so the
rem startup quick login still knows which account to try; drop the MD5 so
rem NapCat never walks password -> captcha -> "new device verify". That chain
rem is what shows up as "every scan asks for a new device", and every attempt
rem is one more risk signal to Tencent. Quick login still runs first; if it
rem fails it just shows the QR code: one step, nothing else.
set "NAPCAT_QUICK_ACCOUNT=1000000001"
rem set "NAPCAT_QUICK_PASSWORD_MD5=YOUR_PASSWORD_MD5"

cd /d "napcat\shell"

rem keep the log bounded: rotate at 5 MB
if not exist "%~dp0data\logs" mkdir "%~dp0data\logs"
for %%F in ("%~dp0data\logs\napcat-run.log") do if %%~zF GTR 5242880 move /y "%%~F" "%~dp0data\logs\napcat-run.old.log" >nul
"%~dp0runtime\node.exe" index-qq-local.js >> "%~dp0data\logs\napcat-run.log" 2>&1
