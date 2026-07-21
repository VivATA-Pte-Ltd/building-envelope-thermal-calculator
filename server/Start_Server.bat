@echo off
setlocal
cd /d "%~dp0\.."

where python >nul 2>nul
if errorlevel 1 (
  echo Python is not installed or not on PATH.
  pause
  exit /b 1
)

if not defined PORT set "PORT=8080"
if not defined UPDATE_INTERVAL_SECONDS set "UPDATE_INTERVAL_SECONDS=21600"
if not defined UPDATE_ON_STARTUP set "UPDATE_ON_STARTUP=true"

echo Starting VivaTEQ Building Envelope Server...
echo Open: http://localhost:%PORT%
echo Press Ctrl+C to stop.
python server\app.py

if errorlevel 1 (
  echo.
  echo Server stopped with an error.
  pause
)
