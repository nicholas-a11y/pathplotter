@echo off
setlocal
cd /d "%~dp0"
rem Runs the RAP window with a visible console so startup errors can be read.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -STA -File "%~dp0GUI.ps1"
if errorlevel 1 (
  echo RAP stopped with an error. See README.md, or your organization's script policy.
  pause
)
