@echo off
node "%~dp0fake-adb.mjs" %*
exit /b %errorlevel%
