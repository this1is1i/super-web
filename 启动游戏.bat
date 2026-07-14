@echo off
cd /d "%~dp0"
chcp 65001 >nul 2>&1
title 超级井字棋

echo.
echo  ╔══════════════════════════════════╗
echo  ║     🎮 超级井字棋 - 网络对战    ║
echo  ╚══════════════════════════════════╝
echo.

:: Check if Node.js is installed
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到 Node.js
    echo 请先安装: https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: Install dependencies if missing
if not exist "node_modules\" (
    echo [安装] 正在安装依赖...
    call npm install
    if %errorlevel% neq 0 (
        echo [错误] 依赖安装失败
        pause
        exit /b 1
    )
    echo.
)

echo [启动] 正在启动服务器...
echo.

node js\server.js
if %errorlevel% neq 0 (
    echo.
    echo [错误] 服务器启动失败，请检查上方错误信息
)

pause
