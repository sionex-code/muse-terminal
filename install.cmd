@echo off
rem Double-click to install the Muse relay on Windows.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
pause
