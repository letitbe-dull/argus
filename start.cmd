@echo off
cd /d "%~dp0"
call npm.cmd install --ignore-scripts
if errorlevel 1 goto end
node cli.mjs
:end
pause
