@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo ffmpeg not found. It is needed for video and keying. Install it and add it to PATH.
  pause
  exit /b 1
)

if not exist "node_modules\@fontsource\noto-serif-sc\500.css" (
  echo First run: installing dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo Installing dependencies failed. See the messages above.
    pause
    exit /b 1
  )
)

node server.mjs --open
if errorlevel 1 pause
