@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.12 or newer is required: https://nodejs.org/
  set "local_exit=1"
  goto finish
)
node "%~dp0scripts\local.mjs" setup %*
set "local_exit=%errorlevel%"
:finish
if not defined LITTLETAKE_NO_PAUSE pause
exit /b %local_exit%
