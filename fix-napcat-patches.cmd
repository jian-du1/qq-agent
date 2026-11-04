@echo off
rem Run this AFTER upgrading NapCat in its WebUI.
rem The upgrade replaces napcat.mjs and wipes the local patches, which causes:
rem   login OK -> crash on mkdir Documents\Tencent Files\NapCat\temp -> restarts -> new QR
rem This script re-applies the patches. It is safe to run any time.
setlocal
cd /d "%~dp0"
echo ============================================
echo  Re-applying NapCat local patches
echo ============================================
echo.
"%~dp0runtime\node.exe" reapply-napcat-patches.mjs
echo.
echo Done. Restart NapCat for the change to take effect.
pause
