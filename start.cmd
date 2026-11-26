@echo off
rem Starts gigproxy and restarts it if it ever exits. Logs to proxy.log in this folder.
rem Run this at logon (see README.md), before the kiosk browser launches.
cd /d "%~dp0"
:loop
echo %date% %time% starting >> proxy.log
node proxy.js >> proxy.log 2>&1
echo %date% %time% exited with code %errorlevel%, restarting in 10s >> proxy.log
timeout /t 10 /nobreak >nul
goto loop
