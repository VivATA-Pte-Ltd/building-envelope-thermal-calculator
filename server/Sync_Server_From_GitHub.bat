@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0\.."

if not defined SERVER_IMAGE set "SERVER_IMAGE=ghcr.io/vivata-pte-ltd/building-envelope-thermal-calculator:server-latest"
set "TRACKING_IMAGE=%SERVER_IMAGE%"
if not defined SERVER_REPOSITORY set "SERVER_REPOSITORY=VivATA-Pte-Ltd/building-envelope-thermal-calculator"
if not defined COSIGN_IDENTITY set "COSIGN_IDENTITY=https://github.com/VivATA-Pte-Ltd/building-envelope-thermal-calculator/.github/workflows/server-ci.yml@refs/heads/main"
if not defined SERVER_PORT set "SERVER_PORT=8080"
set "SERVICE=envelope-calculator"
set "LOGFILE=%~dp0github-sync.log"
set "COSIGN_EXE="
for /f "delims=" %%C in ('where cosign.exe 2^>nul') do if not defined COSIGN_EXE set "COSIGN_EXE=%%C"
for /f "delims=" %%C in ('where cosign-windows-amd64.exe 2^>nul') do if not defined COSIGN_EXE set "COSIGN_EXE=%%C"
if not defined COSIGN_EXE for /d %%D in ("%LOCALAPPDATA%\Microsoft\WinGet\Packages\Sigstore.Cosign_*") do if exist "%%~fD\cosign-windows-amd64.exe" set "COSIGN_EXE=%%~fD\cosign-windows-amd64.exe"

if /i "%~1"=="--check" (
  where docker >nul 2>nul || exit /b 1
  if not defined COSIGN_EXE exit /b 1
  docker compose version >nul 2>nul || exit /b 1
  docker compose config >nul || exit /b 1
  echo GitHub synchronization prerequisites and Compose configuration are valid.
  exit /b 0
)

set "LOCKDIR=%TEMP%\VivaTEQ-Envelope-GitHub-Sync.lock"
if /i not "%~1"=="--locked" (
  2>nul mkdir "%LOCKDIR%"
  if errorlevel 1 (
    echo Another synchronization is running, or the stale lock must be removed: %LOCKDIR%
    exit /b 2
  )
  call "%~f0" --locked
  set "SYNC_RESULT=!errorlevel!"
  rmdir "%LOCKDIR%" >nul 2>nul
  exit /b !SYNC_RESULT!
)

call :log Starting GitHub server-image synchronization.
where docker >nul 2>nul || (call :log ERROR Docker is unavailable. & exit /b 1)
docker compose version >nul 2>nul || (call :log ERROR Docker Compose is unavailable. & exit /b 1)

set "OLD_IMAGE="
set "OLD_DIGEST="
set "OLD_SHA="
set "CONTAINER="
for /f "delims=" %%C in ('docker compose ps -q %SERVICE% 2^>nul') do set "CONTAINER=%%C"
if defined CONTAINER for /f "delims=" %%I in ('docker inspect -f "{{.Image}}" !CONTAINER! 2^>nul') do set "OLD_IMAGE=%%I"
if defined OLD_IMAGE for /f "delims=" %%I in ('docker image inspect -f "{{index .RepoDigests 0}}" !OLD_IMAGE! 2^>nul') do set "OLD_DIGEST=%%I"
if defined OLD_IMAGE for /f "tokens=1,* delims==" %%A in ('docker image inspect -f "{{range .Config.Env}}{{println .}}{{end}}" !OLD_IMAGE! 2^>nul ^| findstr /B "APP_GIT_SHA="') do set "OLD_SHA=%%B"

set "EXPECTED_FILE=%TEMP%\vivateq-envelope-expected-!RANDOM!-!RANDOM!.txt"
curl -fsSL -H "Accept: application/vnd.github.sha" "https://api.github.com/repos/%SERVER_REPOSITORY%/commits/main" >"!EXPECTED_FILE!"
if errorlevel 1 (del "!EXPECTED_FILE!" >nul 2>nul & call :log ERROR Unable to read the current GitHub main commit. Existing server retained. & exit /b 1)
set "EXPECTED_SHA="
set /p EXPECTED_SHA=<"!EXPECTED_FILE!"
del "!EXPECTED_FILE!" >nul 2>nul
if not defined EXPECTED_SHA (call :log ERROR GitHub returned no main commit. Existing server retained. & exit /b 1)
powershell.exe -NoProfile -NonInteractive -Command "if ($env:EXPECTED_SHA -notmatch '^[0-9a-fA-F]{40}$') { exit 1 }"
if errorlevel 1 (call :log ERROR GitHub returned an invalid main commit identifier. Existing server retained. & exit /b 1)

docker compose pull %SERVICE%
if errorlevel 1 (call :log ERROR Unable to pull the approved GitHub image. Existing server retained. & exit /b 1)
set "NEW_DIGEST="
for /f "delims=" %%I in ('docker image inspect -f "{{index .RepoDigests 0}}" "%TRACKING_IMAGE%" 2^>nul') do set "NEW_DIGEST=%%I"
if not defined NEW_DIGEST (call :log ERROR Pulled image has no immutable registry digest. Existing server retained. & exit /b 1)
if not defined COSIGN_EXE (call :log ERROR Cosign is unavailable; unsigned images are never deployed. & exit /b 1)
if defined OLD_IMAGE (
  if not defined OLD_DIGEST (call :log ERROR Running server image has no immutable digest and cannot be a verified rollback target. Existing server retained. & exit /b 1)
  if not defined OLD_SHA (call :log ERROR Running server image has no Git commit identity and cannot be a verified rollback target. Existing server retained. & exit /b 1)
  set "EXPECTED_OLD_SHA=!OLD_SHA!"
  powershell.exe -NoProfile -NonInteractive -Command "if ($env:EXPECTED_OLD_SHA -notmatch '^[0-9a-fA-F]{40}$') { exit 1 }" >nul 2>nul
  if errorlevel 1 (call :log ERROR Running server Git SHA is malformed; automatic replacement refused. Existing server retained. & exit /b 1)
  "%COSIGN_EXE%" verify --certificate-identity "%COSIGN_IDENTITY%" --certificate-oidc-issuer "https://token.actions.githubusercontent.com" "!OLD_DIGEST!" >nul
  if errorlevel 1 (call :log ERROR Running server image is not signed by the approved workflow. Existing server retained. & exit /b 1)
  set "VERIFIED_OLD_IMAGE="
  for /f "delims=" %%I in ('docker image inspect -f "{{.Id}}" "!OLD_DIGEST!" 2^>nul') do set "VERIFIED_OLD_IMAGE=%%I"
  if /i not "!VERIFIED_OLD_IMAGE!"=="!OLD_IMAGE!" (call :log ERROR Running server does not match its verified rollback digest. Existing server retained. & exit /b 1)
)
"%COSIGN_EXE%" verify --certificate-identity "%COSIGN_IDENTITY%" --certificate-oidc-issuer "https://token.actions.githubusercontent.com" "!NEW_DIGEST!" >nul
if errorlevel 1 (call :log ERROR Image signature verification failed. Existing server retained. & exit /b 1)

set "NEW_IMAGE="
set "NEW_SHA="
for /f "delims=" %%I in ('docker image inspect -f "{{.Id}}" "!NEW_DIGEST!" 2^>nul') do set "NEW_IMAGE=%%I"
for /f "tokens=1,* delims==" %%A in ('docker image inspect -f "{{range .Config.Env}}{{println .}}{{end}}" "!NEW_DIGEST!" 2^>nul ^| findstr /B "APP_GIT_SHA="') do set "NEW_SHA=%%B"
if not defined NEW_IMAGE (call :log ERROR Pulled image could not be inspected. Existing server retained. & exit /b 1)
if not defined NEW_SHA (call :log ERROR Pulled image has no tested Git commit metadata. Existing server retained. & exit /b 1)
if /i "!NEW_SHA!"=="unknown" (call :log ERROR Pulled image has invalid Git commit metadata. Existing server retained. & exit /b 1)
if /i not "!NEW_SHA!"=="!EXPECTED_SHA!" (call :log GitHub main is !EXPECTED_SHA!, but the tested image is !NEW_SHA!. Existing server retained until publication completes. & exit /b 1)
set "FRESH_MAIN_FILE=%TEMP%\vivateq-envelope-fresh-main-!RANDOM!-!RANDOM!.txt"
curl -fsSL -H "Accept: application/vnd.github.sha" "https://api.github.com/repos/%SERVER_REPOSITORY%/commits/main" >"!FRESH_MAIN_FILE!"
if errorlevel 1 (del "!FRESH_MAIN_FILE!" >nul 2>nul & call :log ERROR Unable to recheck GitHub main before replacement. Existing server retained. & exit /b 1)
set "FRESH_MAIN_SHA="
set /p FRESH_MAIN_SHA=<"!FRESH_MAIN_FILE!"
del "!FRESH_MAIN_FILE!" >nul 2>nul
powershell.exe -NoProfile -NonInteractive -Command "if ($env:FRESH_MAIN_SHA -notmatch '^[0-9a-fA-F]{40}$') { exit 1 }"
if errorlevel 1 (call :log ERROR GitHub returned an invalid commit during the final main check. Existing server retained. & exit /b 1)
if /i not "!FRESH_MAIN_SHA!"=="!NEW_SHA!" (call :log GitHub main advanced to !FRESH_MAIN_SHA! before replacement. Existing server retained until its signed image is published. & exit /b 1)
if /i "!OLD_IMAGE!"=="!NEW_IMAGE!" (call :log Server already matches Git commit !NEW_SHA! in image !NEW_IMAGE!. & exit /b 0)

set "SERVER_IMAGE=!NEW_DIGEST!"
set "HEALTH_FILE=%TEMP%\vivateq-envelope-health-!RANDOM!-!RANDOM!.json"
docker compose up -d --no-build --force-recreate --pull never --wait --wait-timeout 120 %SERVICE%
if not errorlevel 1 (
  set "DEPLOYED_CONTAINER="
  set "DEPLOYED_IMAGE="
  for /f "delims=" %%C in ('docker compose ps -q %SERVICE% 2^>nul') do set "DEPLOYED_CONTAINER=%%C"
  if defined DEPLOYED_CONTAINER for /f "delims=" %%I in ('docker inspect -f "{{.Image}}" !DEPLOYED_CONTAINER! 2^>nul') do set "DEPLOYED_IMAGE=%%I"
  if /i not "!DEPLOYED_IMAGE!"=="!NEW_IMAGE!" cmd /c exit 1
)
if not errorlevel 1 curl -fsS http://127.0.0.1:%SERVER_PORT%/api/health >"!HEALTH_FILE!"
if not errorlevel 1 (
  set "EXPECTED_HEALTH_SHA=!NEW_SHA!"
  powershell.exe -NoProfile -NonInteractive -Command "$h=Get-Content -Raw -LiteralPath $env:HEALTH_FILE | ConvertFrom-Json; if ($h.status -cne 'ok' -or $h.git_sha -cne $env:EXPECTED_HEALTH_SHA) { exit 1 }"
)
if not errorlevel 1 (
  del "!HEALTH_FILE!" >nul 2>nul
  call :log Updated server to tested Git commit !NEW_SHA! in image !NEW_IMAGE! and passed its health check.
  exit /b 0
)
del "!HEALTH_FILE!" >nul 2>nul

call :log ERROR New image failed health or Git-commit verification. Starting rollback.
if not defined OLD_IMAGE (call :log ERROR No previous verified image exists for rollback. & exit /b 1)
if not defined OLD_DIGEST (call :log ERROR No previous verified digest exists for rollback. & exit /b 1)
set "SERVER_IMAGE=!OLD_DIGEST!"
"%COSIGN_EXE%" verify --certificate-identity "%COSIGN_IDENTITY%" --certificate-oidc-issuer "https://token.actions.githubusercontent.com" "!OLD_DIGEST!" >nul
if errorlevel 1 (call :log ERROR Previous image signature could not be reverified for rollback. & exit /b 1)
docker compose up -d --no-build --force-recreate --pull never --wait --wait-timeout 120 %SERVICE%
if errorlevel 1 (call :log ERROR Rollback container failed its health check. & exit /b 1)
set "RESTORED_CONTAINER="
set "RESTORED_IMAGE="
for /f "delims=" %%C in ('docker compose ps -q %SERVICE% 2^>nul') do set "RESTORED_CONTAINER=%%C"
if defined RESTORED_CONTAINER for /f "delims=" %%I in ('docker inspect -f "{{.Image}}" !RESTORED_CONTAINER! 2^>nul') do set "RESTORED_IMAGE=%%I"
if /i not "!RESTORED_IMAGE!"=="!OLD_IMAGE!" (call :log ERROR Rollback did not restore the previous image identity. & exit /b 1)
set "ROLLBACK_HEALTH=%TEMP%\vivateq-envelope-rollback-!RANDOM!-!RANDOM!.json"
curl -fsS http://127.0.0.1:%SERVER_PORT%/api/health >"!ROLLBACK_HEALTH!"
if errorlevel 1 (del "!ROLLBACK_HEALTH!" >nul 2>nul & call :log ERROR Rollback health endpoint failed. & exit /b 1)
set "EXPECTED_HEALTH_SHA=!OLD_SHA!"
powershell.exe -NoProfile -NonInteractive -Command "$h=Get-Content -Raw -LiteralPath $env:ROLLBACK_HEALTH | ConvertFrom-Json; if ($h.status -cne 'ok' -or $h.git_sha -cne $env:EXPECTED_HEALTH_SHA) { exit 1 }"
if errorlevel 1 (del "!ROLLBACK_HEALTH!" >nul 2>nul & call :log ERROR Rollback health or Git commit identity did not match the previous verified release. & exit /b 1)
del "!ROLLBACK_HEALTH!" >nul 2>nul
call :log Rollback completed successfully; previous image !OLD_IMAGE! and Git commit !OLD_SHA! restored.
exit /b 1

:log
echo [%date% %time%] %*
>>"%LOGFILE%" echo [%date% %time%] %*
exit /b 0
