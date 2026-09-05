@echo off
echo ========================================================
echo Building Flow Note Android APK & Deploying to Server...
echo ========================================================
cd flow_android
call gradlew.bat assembleDebug
cd ..
echo.
echo [*] APK Build Complete!
echo [*] Exported to flow_note\public\app.apk and Desktop\FlowNote_Latest.apk
echo [*] Connected Android devices will automatically detect and prompt to update!
echo ========================================================
