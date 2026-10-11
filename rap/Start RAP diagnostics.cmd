@echo off
setlocal
cd /d "%~dp0"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -File "%~dp0RAP.ps1"
if errorlevel 1 (
  echo RAP stopped. Check README.md and your organization's signed-script policy.
  pause
)
