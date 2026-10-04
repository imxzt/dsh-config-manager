@echo off
rem dcm.bat - dsh-config-manager launcher (Windows)
rem
rem Double-click to open the external UI; pass arguments to use the CLI.
rem Finds DSH's bundled node first, falls back to node on PATH.
rem
rem NOTE: this file MUST be saved as UTF-8 **with BOM** and CRLF.
rem   cmd.exe reads .bat in the OEM code page (936/GBK on a Chinese Windows).
rem   Without the BOM the Chinese lines below are decoded as GBK garbage,
rem   which breaks parsing: the text gets split into bogus tokens and the
rem   remainder is executed as a command. Same class of bug as .ps1 needs a BOM.

if not "%~1"=="" chcp 65001 >nul

setlocal EnableDelayedExpansion

set "DCM_DIR=%~dp0"
set "NODE="

rem 1) DSH bundled runtime: version matches DSH itself, no PATH dependency.
if defined DSH_HOME (
  for /d %%D in ("%DSH_HOME%\dsh-runtimes\*") do (
    if exist "%%~fD\dependencies\node\bin\node.exe" set "NODE=%%~fD\dependencies\node\bin\node.exe"
  )
)
rem 2) default home
if not defined NODE if exist "%USERPROFILE%\.dsh\dsh-runtimes" (
  for /d %%D in ("%USERPROFILE%\.dsh\dsh-runtimes\*") do (
    if exist "%%~fD\dependencies\node\bin\node.exe" set "NODE=%%~fD\dependencies\node\bin\node.exe"
  )
)
rem 3) node on PATH
if not defined NODE (
  where node >nul 2>nul
  if not errorlevel 1 set "NODE=node"
)

if not defined NODE (
  echo.
  echo [ERROR] node not found.
  echo.
  echo This tool needs Node.js. Three ways to fix:
  echo   "1)" Make sure DSH is installed and DSH_HOME points at its home.
  echo   "2)" Install Node.js from https://nodejs.org and add it to PATH.
  echo   "3)" Set it manually: set NODE=C:\path\to\node.exe and re-run.
  echo.
  pause
  exit /b 1
)

set "DCM=%DCM_DIR%bin\dcm.mjs"
if not exist "%DCM%" (
  echo [ERROR] %DCM% not found - incomplete plugin directory, please re-clone.
  pause
  exit /b 1
)

if "%~1"=="" (
  rem Double-click path. Must pause on error: otherwise the window
  rem flashes and vanishes, and the user sees nothing at all.
  "%NODE%" "%DCM%" serve --open
  if errorlevel 1 (
    echo.
    echo [ERROR] failed to start, see the message above.
    pause
  )
) else (
  "%NODE%" "%DCM%" %*
  if errorlevel 1 pause
)
endlocal