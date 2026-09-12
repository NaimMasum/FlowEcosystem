@echo off
:: Batch script to install and start FlowServer as an automatic Windows Service

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Requesting Administrator privileges to install Windows Service...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"
echo ===================================================================
echo   FLOW ECOSYSTEM - INSTALL WINDOWS SERVICE
echo ===================================================================
echo.

if not exist "FlowServer.exe" (
    if exist "dist\FlowServer.exe" (
        copy /Y "dist\FlowServer.exe" "FlowServer.exe" >nul
    ) else (
        echo [!] FlowServer.exe not found! Please run build_server_exe.bat first.
        pause
        exit /b 1
    )
)

FlowServer.exe --install-service

echo.
FlowServer.exe --status
echo.
pause
