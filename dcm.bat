@echo off
rem dcm.bat — dsh-config-manager launcher (Windows)
rem
rem 双击即可打开外部 UI；带参数则当命令行用。
rem 自动寻找 DSH 内置 node，找不到再退回 PATH 里的 node —— 不写死任何用户路径。

setlocal EnableDelayedExpansion

set "DCM_DIR=%~dp0"
set "NODE="

rem 1) DSH 内置运行时（首选：版本与 DSH 自身一致，不依赖 PATH）
if defined DSH_HOME (
  for /d %%D in ("%DSH_HOME%\dsh-runtimes\*") do (
    if exist "%%~fD\dependencies\node\bin\node.exe" set "NODE=%%~fD\dependencies\node\bin\node.exe"
  )
)
rem 2) 缺省 home 下的运行时
if not defined NODE if exist "%USERPROFILE%\.dsh\dsh-runtimes" (
  for /d %%D in ("%USERPROFILE%\.dsh\dsh-runtimes\*") do (
    if exist "%%~fD\dependencies\node\bin\node.exe" set "NODE=%%~fD\dependencies\node\bin\node.exe"
  )
)
rem 3) PATH 里的 node
if not defined NODE (
  where node >nul 2>nul
  if not errorlevel 1 set "NODE=node"
)

if not defined NODE (
  echo.
  echo 找不到 node。
  echo.
  echo 本工具需要 Node.js 才能运行。三种解决办法：
  echo   1^) 确认 DSH 已安装且 DSH_HOME 指向它的主目录；
  echo   2^) 安装 Node.js ^(https://nodejs.org^) 并加入 PATH；
  echo   3^) 手动指定：set NODE=C:\path\to\node.exe 后重跑本脚本。
  echo.
  pause
  exit /b 1
)

set "DCM=%DCM_DIR%bin\dcm.mjs"
if not exist "%DCM%" (
  echo 找不到 %DCM% —— 插件目录不完整，请重新克隆仓库。
  pause
  exit /b 1
)

if "%~1"=="" (
  "%NODE%" "%DCM%" serve --open
) else (
  "%NODE%" "%DCM%" %*
  if errorlevel 1 pause
)
endlocal