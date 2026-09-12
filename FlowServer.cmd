@echo off
:: FlowServer CLI & Service Runner
setlocal

set "ROOT=%~dp0"
set "EXE=%ROOT%FlowServer.exe"
set "DLL=%ROOT%FlowServer\bin\Release\net9.0-windows\win-x64\FlowServer.dll"
if not exist "%DLL%" set "DLL=%ROOT%dist\FlowServer.dll"

:: Run through dotnet host if Smart App Control restricts unsigned PE files, otherwise run exe directly
where dotnet >nul 2>nul
if %errorlevel% equ 0 (
    if exist "%DLL%" (
        dotnet "%DLL%" %*
        exit /b %errorlevel%
    )
)

if exist "%EXE%" (
    "%EXE%" %*
    exit /b %errorlevel%
)

echo [!] FlowServer binary not found. Run build_server_exe.bat first.
exit /b 1
