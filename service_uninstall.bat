@echo off
:: Batch script to stop and remove the FlowServer Windows Service

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Requesting Administrator privileges to remove Windows Service...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"
echo ===================================================================
echo   FLOW ECOSYSTEM - UNINSTALL WINDOWS SERVICE
echo ===================================================================
echo.

if exist "FlowServer.exe" (
    FlowServer.exe --uninstall-service
) else (
    sc.exe stop FlowServer
    sc.exe delete FlowServer
)

echo.
echo Service status:
sc.exe query FlowServer
echo.
pause
