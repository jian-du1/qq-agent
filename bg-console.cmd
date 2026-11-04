@echo off
rem Console service (3210), hidden.
rem Skip if the console node process is ALREADY running (command line check,
rem which has no cold-start race like the old port check did).
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*src\server.js*' }) { exit 1 } else { exit 0 }"
if errorlevel 1 exit /b 0

if not exist "tmp" mkdir "tmp"
set "TEMP=%CD%\tmp"
set "TMP=%CD%\tmp"
if not exist "data" mkdir "data"

"%~dp0runtime\node.exe" "%~dp0src\server.js"
