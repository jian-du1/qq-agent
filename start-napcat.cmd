@echo off
setlocal
title NapCat (QQ protocol)
cd /d "%~dp0"

if not exist "napcat\shell\index-qq-local.js" (
  echo [ERROR] NapCat not found. Run from the qq-agent folder.
  echo Current dir: %CD%
  pause
  exit /b 1
)
if not exist "runtime\node.exe" (
  echo [ERROR] runtime\node.exe missing.
  pause
  exit /b 1
)

rem --- duplicate guard: one NapCat per QQ account only ---
for %%P in (6099 6100 6101 6102 6103 6104 6105 3000 3001) do (
  netstat -ano | findstr /r /c:":%%P .*LISTENING" >nul
  if not errorlevel 1 (
    echo [SKIP] NapCat already running ^(port %%P in use^).
    echo        Do not start a second one - two instances fight over the same QQ account.
    echo.
    pause
    exit /b 0
  )
)

if not exist "tmp" mkdir "tmp"
set "TEMP=%CD%\tmp"
set "TMP=%CD%\tmp"

rem QQ data lives INSIDE the project (napcat\qqdata).
rem Reason: pointing it at Documents\Tencent Files makes the worker hang right
rem after "login success" on this machine, so the bot never comes up.
rem Trade-off: the login token is not persisted -> a QR scan is needed per start,
rem UNLESS the account has a local QQ login record (see README: log the bot
rem account into the desktop QQ once, then quit it, then use -q).
if not exist "napcat\qqdata" mkdir "napcat\qqdata"
set "NAPCAT_DATA_OVERRIDE=%CD%\napcat\qqdata"

rem Optional quick login: pass the account number as the first argument,
rem e.g.  start-napcat.cmd 1000000001
set "QUICK_UIN=%~1"

cd /d "napcat\shell"
echo ============================================
echo  Starting NapCat (uses local QQ core)
echo.
echo  WebUI : http://127.0.0.1:6099/webui
echo  Token : see "WebUi Token" printed below
echo  OneBot: HTTP 3000 / WS 3001 (after login)
echo.
echo  Keep this window open. Close it to stop.
echo  Red [E] MMKV lines are harmless warnings.
echo ============================================
echo.

if defined QUICK_UIN (
  echo  Quick login : %QUICK_UIN%
  "%~dp0runtime\node.exe" index-qq-local.js -q %QUICK_UIN%
) else (
  "%~dp0runtime\node.exe" index-qq-local.js
)

echo.
echo [NapCat exited] Press any key to close...
pause >nul
