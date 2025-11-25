@echo off
REM Change directory to the script location
cd /d %~dp0

REM Ensure Puppeteer can find the expected temp directories
SET "LOCALAPPDATA=C:\Users\%USERNAME%\AppData\Local"
SET "TEMP=%LOCALAPPDATA%\Temp"
SET "TMP=%LOCALAPPDATA%\Temp"

REM Resolve Node.js installation directory if NODE_PATH is not already defined
IF NOT DEFINED NODE_PATH (
  SET "NODE_PATH=%ProgramFiles%\nodejs"
)

REM Abort if npm.cmd cannot be located
IF NOT EXIST "%NODE_PATH%\npm.cmd" (
  echo [%DATE% %TIME%] npm.cmd introuvable dans "%NODE_PATH%". >> log.txt
  exit /b 1
)

REM Ensure npm is on PATH for the current session
SET "PATH=%NODE_PATH%;%PATH%"

REM Log startup
echo [%DATE% %TIME%] Démarrage du scraper CPF >> log.txt

REM Run the extraction process and append output to the log
REM "%NODE_PATH%\npm.cmd" run extract -- --city montpellier grenoble bordeaux angers nantes >> log.txt 2>&1
"%NODE_PATH%\npm.cmd" run extract >> log.txt 2>&1