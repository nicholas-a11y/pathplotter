@echo off
setlocal
cd /d "%~dp0"
start "" "%SystemRoot%\System32\wscript.exe" "%~dp0Start RAP.vbs"
