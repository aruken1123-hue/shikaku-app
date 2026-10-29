@echo off
rem Start the local server for the study app and open it in the browser.
rem Close this window to stop the server.
cd /d "%~dp0"
echo Shikaku app: http://127.0.0.1:8790/
echo Close this window to stop.
rem Open the browser after the server has had time to start.
start "" /min powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8790/'"
python tools\devserver.py 8790
if errorlevel 1 (
  echo.
  echo Failed to start. Python may not be installed, or port 8790 is in use.
  pause
)
