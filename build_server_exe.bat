@echo off
setlocal enabledelayedexpansion

echo ===================================================================
echo   FLOW ECOSYSTEM - STANDALONE SERVER BUILDER
echo ===================================================================
echo.

:: 1. Verify Prerequisites
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [!] Error: Node.js is required on the build machine.
    pause
    exit /b 1
)

where dotnet >nul 2>nul
if %errorlevel% neq 0 (
    echo [!] Error: .NET 9 SDK is required on the build machine.
    pause
    exit /b 1
)

:: 2. Ensure resources directories exist
if not exist "FlowServer\Resources\public" mkdir "FlowServer\Resources\public"
if not exist "dist" mkdir "dist"

:: 3. Bundle Server Code
echo [*] Bundling flow_note server logic with esbuild...
call npx esbuild flow_note\server.js --bundle --platform=node --target=node20 --outfile=FlowServer\Resources\server.bundle.js
if %errorlevel% neq 0 (
    echo [!] Failed to bundle server.js.
    pause
    exit /b 1
)

:: 4. Copy Web Assets
echo [*] Syncing public web assets to resource directory...
copy /Y "flow_note\public\index.html" "FlowServer\Resources\public\" >nul
copy /Y "flow_note\public\app.js" "FlowServer\Resources\public\" >nul
copy /Y "flow_note\public\style.css" "FlowServer\Resources\public\" >nul

:: 5. Compress Node Engine if not already present
if not exist "FlowServer\Resources\node.gz" (
    echo [*] Compressing Node.js engine for standalone bundling...
    powershell -NoProfile -Command ^
        "$node = (Get-Command node).Source; " ^
        "$dest = 'FlowServer\Resources\node.gz'; " ^
        "$s = [System.IO.File]::OpenRead($node); " ^
        "$d = [System.IO.File]::Create($dest); " ^
        "$gz = [System.IO.Compression.GZipStream]::new($d, [System.IO.Compression.CompressionLevel]::Optimal); " ^
        "$s.CopyTo($gz); " ^
        "$gz.Dispose(); $d.Dispose(); $s.Dispose();"
)

:: 6. Compile Self-Contained Standalone Executable
echo [*] Compiling single-file native Windows executable (win-x64)...
dotnet publish FlowServer\FlowServer.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o dist\
if %errorlevel% neq 0 (
    echo [!] dotnet publish failed.
    pause
    exit /b 1
)

:: 7. Deploy to Root
copy /Y "dist\FlowServer.exe" "FlowServer.exe" >nul

echo.
echo ===================================================================
echo   [✓] BUILD COMPLETE!
echo ===================================================================
echo   Executable: FlowServer.exe
echo   Location:   %~dp0FlowServer.exe
echo.
echo   How to run:
echo     1. Interactive Console:
echo        FlowServer.exe
echo.
echo     2. Install Windows Service (Runs at system boot):
echo        FlowServer.exe --install-service   (Run as Administrator)
echo.
echo     3. Install User Startup (Runs at user login):
echo        FlowServer.exe --install-startup   (No admin needed)
echo.
echo     4. Check status:
echo        FlowServer.exe --status
echo ===================================================================
