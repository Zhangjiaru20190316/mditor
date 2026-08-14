@echo off
setlocal enableextensions enabledelayedexpansion
cd /d "%~dp0"
title Mditor 打包发布

echo.
echo =========================================
echo          Mditor 一键打包 (release)
echo =========================================
echo.

rem ===== 1. 环境检查 =====
echo [1/4] 检查运行环境...

where node >nul 2>nul
if errorlevel 1 goto :no_node
for /f "delims=" %%v in ('node --version') do set "NODE_VER=%%v"
echo     Node.js : %NODE_VER%

where npm >nul 2>nul
if errorlevel 1 goto :no_npm
for /f "delims=" %%v in ('npm --version') do set "NPM_VER=%%v"
echo     npm     : %NPM_VER%

where rustc >nul 2>nul
if errorlevel 1 goto :no_rust
for /f "delims=" %%v in ('rustc --version') do set "RUST_VER=%%v"
echo     Rust    : %RUST_VER%

where cargo >nul 2>nul
if errorlevel 1 goto :no_rust
for /f "delims=" %%v in ('cargo --version') do set "CARGO_VER=%%v"
echo     Cargo   : %CARGO_VER%

echo     [OK] 环境就绪
echo.

rem ===== 2. 依赖安装 =====
echo [2/4] 检查前端依赖 (node_modules)...
if exist "node_modules" goto :dep_ok
echo     未安装，正在安装前端依赖...
call npm install
if errorlevel 1 goto :fail
goto :dep_done
:dep_ok
echo     已存在，跳过 (如需更新请先删除 node_modules)
:dep_done
echo.

rem ===== 3. 图标检查 =====
echo [3/4] 检查应用图标...
if exist "src-tauri\icons\icon.ico" goto :ic_ok
echo     生成图标中...
call npm run icons
if errorlevel 1 goto :fail
goto :ic_done
:ic_ok
echo     已存在，跳过
:ic_done
echo.

rem ===== 4. 打包 =====
echo [4/4] 开始打包 (tauri build)...
echo     - 前端将通过 beforeBuildCommand 自动构建
echo     - Rust 使用 release profile (LTO + strip)
echo     - 首次 release 编译较慢，请耐心等待
echo.
call npm run tauri build
if errorlevel 1 goto :fail

rem ===== 产物输出 =====
set "BUNDLE_DIR=src-tauri\target\release\bundle"
echo.
echo =========================================
echo    打包成功！
echo =========================================
echo.
echo 产物位置：
if exist "%BUNDLE_DIR%\nsis" (
    echo   [NSIS 安装包]
    for %%F in ("%BUNDLE_DIR%\nsis\*.exe") do echo     - %%F
)
if exist "%BUNDLE_DIR%\msi" (
    echo   [MSI 安装包]
    for %%F in ("%BUNDLE_DIR%\msi\*.msi") do echo     - %%F
)
if exist "%BUNDLE_DIR%\*.exe" (
    echo   [可执行文件]
    for %%F in ("%BUNDLE_DIR%\*.exe") do echo     - %%F
)
echo.
echo 可执行文件：
if exist "src-tauri\target\release\mditor.exe" (
    echo     - src-tauri\target\release\mditor.exe
)
echo.
echo 提示：如需生成自动更新签名包，请配置环境变量：
echo   TAURI_SIGNING_PRIVATE_KEY
echo   TAURI_SIGNING_PRIVATE_KEY_PASSWORD
echo 并重新运行本脚本。
echo.
pause
exit /b 0

:no_node
echo [X] 未检测到 Node.js，请先安装 Node.js 18+
echo     正在打开下载页面...
start "" https://nodejs.org/
pause
exit /b 1

:no_npm
echo [X] 未检测到 npm
pause
exit /b 1

:no_rust
echo [X] 未检测到 Rust，请先安装 rustup (stable)
echo     正在打开下载页面...
start "" https://rustup.rs/
pause
exit /b 1

:fail
echo.
echo =========================================
echo    打包失败，请查看上方错误信息
echo =========================================
pause
exit /b 1
