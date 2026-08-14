@echo off
setlocal enableextensions
cd /d "%~dp0"
title Mditor 开发模式

echo.
echo =========================================
echo          Mditor 一键启动 (dev)
echo =========================================
echo.

rem ===== 1. 环境检查 =====
echo [1/3] 检查运行环境...

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

echo     [OK] 环境就绪
echo.

rem ===== 2. 前端依赖 =====
echo [2/3] 检查前端依赖 (node_modules)...
if exist "node_modules" goto :dep_ok
echo     首次启动，需要安装依赖（可能耗时几分钟）...
call npm install
if errorlevel 1 goto :fail
goto :dep_done
:dep_ok
echo     已存在，跳过
:dep_done
echo.

rem ===== 3. 图标检查 =====
echo [3/3] 检查应用图标...
if exist "src-tauri\icons\icon.ico" goto :ic_ok
echo     生成图标中...
call npm run icons
if errorlevel 1 goto :fail
goto :ic_done
:ic_ok
echo     已存在，跳过
:ic_done
echo.

rem ===== 启动 =====
echo =========================================
echo   启动 tauri dev ...
echo   首次编译 Rust 会下载约 200 个 crate
echo   (5-15 分钟)，请耐心等待
echo =========================================
echo.
call npm run tauri dev
if errorlevel 1 goto :fail

echo.
echo =========================================
echo    Mditor 已退出
echo =========================================
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
echo    启动失败，请查看上方错误信息
echo =========================================
pause
exit /b 1
