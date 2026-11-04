@echo off
rem Hard stop: kill every node.exe belonging to this deployment.
rem Needed because stop-all.cmd only kills whatever is listening on the ports,
rem and stale instances that failed to bind keep running in the background.
setlocal
echo Killing all node.exe ...
taskkill /IM node.exe /F >nul 2>&1
timeout /t 3 >nul

echo Remaining node processes:
tasklist /FI "IMAGENAME eq node.exe" 2>nul | find /i "node.exe" >nul
if errorlevel 1 (echo   none) else (echo   still some - check Task Manager)

echo.
echo Ports check:
for %%P in (3210 6099 6100 3000 3001) do (
  netstat -ano | findstr /r /c:":%%P .*LISTENING" >nul
  if not errorlevel 1 (echo   %%P still in use) else (echo   %%P free)
)
timeout /t 3 >nul
