@echo off
setlocal
set "TASK_NAME=VivaTEQ Envelope Server GitHub Sync"
set "SYNC_SCRIPT=%~dp0Sync_Server_From_GitHub.bat"

where schtasks >nul 2>nul
if errorlevel 1 (
  echo Windows Task Scheduler is unavailable.
  pause
  exit /b 1
)

if /i "%~1"=="--check" (
  if not exist "%~dp0Sync_Server_From_GitHub.bat" exit /b 1
  echo Automatic synchronization installer prerequisites are valid.
  exit /b 0
)

set "COSIGN_FOUND="
for /f "delims=" %%C in ('where cosign.exe 2^>nul') do set "COSIGN_FOUND=%%C"
for /f "delims=" %%C in ('where cosign-windows-amd64.exe 2^>nul') do if not defined COSIGN_FOUND set "COSIGN_FOUND=%%C"
if not defined COSIGN_FOUND for /d %%D in ("%LOCALAPPDATA%\Microsoft\WinGet\Packages\Sigstore.Cosign_*") do if exist "%%~fD\cosign-windows-amd64.exe" set "COSIGN_FOUND=%%~fD\cosign-windows-amd64.exe"
if not defined COSIGN_FOUND (
  where winget >nul 2>nul || (
    echo Cosign is required to verify signed server images, and winget is unavailable.
    pause
    exit /b 1
  )
  echo Installing Sigstore Cosign for signed-image verification...
  winget install --id Sigstore.Cosign -e --silent --accept-package-agreements --accept-source-agreements
  if errorlevel 1 (
    echo Cosign installation failed; no automatic deployment task was created.
    pause
    exit /b 1
  )
)

schtasks /Create /F /SC MINUTE /MO 15 /TN "%TASK_NAME%" /TR "\"%SYNC_SCRIPT%\""
if errorlevel 1 (
  echo.
  echo The automatic synchronization task could not be created.
  echo Try right-clicking this installer and choosing Run as administrator.
  pause
  exit /b 1
)

echo.
echo Automatic GitHub server synchronization is installed.
echo Task: %TASK_NAME%
echo Frequency: every 15 minutes
echo Log: %~dp0github-sync.log
echo.
echo The updater verifies the GitHub Actions signature and exact main commit,
echo checks health and identity, and rolls back to the verified previous image.
pause
