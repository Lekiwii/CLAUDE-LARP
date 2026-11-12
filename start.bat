@echo off
rem Double-click to launch LARP on Windows.
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo First launch: installing dependencies, this takes a minute...
  call npm install
  if errorlevel 1 (
    echo.
    echo Install failed. Is Node.js installed? https://nodejs.org
    pause
    exit /b 1
  )
)
set ELECTRON_RUN_AS_NODE=
start "" "node_modules\electron\dist\electron.exe" .
