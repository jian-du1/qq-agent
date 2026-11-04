@echo off
rem Debug launcher: same as start-napcat.cmd but writes ALL output to a log file
rem so the crash stack can be read afterwards. Nothing changes functionally.
setlocal
cd /d "%~dp0"

if not exist "runtime\node.exe" (
  echo [ERROR] runtime\node.exe missing.
  pause
  exit /b 1
)

if not exist "tmp" mkdir "tmp"
set "TEMP=%CD%\tmp"
set "TMP=%CD%\tmp"

if not exist "napcat\qqdata" mkdir "napcat\qqdata"
set "NAPCAT_DATA_OVERRIDE=%CD%\napcat\qqdata"

rem keep a previous crash for comparison
if exist "napcat-debug.log" move /y "napcat-debug.log" "napcat-debug.prev.log" >nul

cd /d "napcat\shell"
echo Logging to napcat-debug.log ...
"%~dp0runtime\node.exe" index-qq-local.js > "%~dp0napcat-debug.log" 2>&1

echo.
echo [NapCat exited] code=%errorlevel%
echo Log: %~dp0napcat-debug.log
pause
