@echo off
setlocal
title QQ Agent console
cd /d "%~dp0"

if not exist "runtime\node.exe" (
  echo [ERROR] runtime\node.exe missing.
  pause
  exit /b 1
)

set "QQ_AGENT_PORT=3210"
echo ============================================
echo  QQ Agent console
echo  URL: http://127.0.0.1:%QQ_AGENT_PORT%
echo  Close this window to stop.
echo ============================================
echo.
start "" "http://127.0.0.1:%QQ_AGENT_PORT%"
"%~dp0runtime\node.exe" src\server.js
echo.
echo [server exited] Press any key to close...
pause >nul
