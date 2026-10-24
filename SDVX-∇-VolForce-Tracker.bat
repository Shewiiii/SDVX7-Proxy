@echo off
setlocal

cd /d "%~dp0"
if exist "%~dp0.venv\Scripts\python.exe" (
    "%~dp0.venv\Scripts\python.exe" -m tracker.launcher %*
    goto done
)
if exist "%~dp0venv\Scripts\python.exe" (
    "%~dp0venv\Scripts\python.exe" -m tracker.launcher %*
    goto done
)
where py >nul 2>nul
if not errorlevel 1 (
    py -3 -m tracker.launcher %*
    goto done
)
python -m tracker.launcher %*

:done
set "TRACKER_EXIT=%errorlevel%"
if not "%TRACKER_EXIT%"=="0" pause
exit /b %TRACKER_EXIT%
