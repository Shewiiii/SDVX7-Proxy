@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0.venv\Scripts\python.exe" (
    "%~dp0.venv\Scripts\python.exe" -m tracker.setup %*
    goto done
)
where py >nul 2>nul
if not errorlevel 1 (
    py -3 -m tracker.setup %*
    goto done
)
where python >nul 2>nul
if not errorlevel 1 (
    python -m tracker.setup %*
    goto done
)
echo Python was not found. Install Python 3.10 or newer from https://www.python.org/downloads/
echo Enable "Add python.exe to PATH", then run setup.bat again.
pause
exit /b 1

:done
set "SETUP_EXIT=%errorlevel%"
if not "%SETUP_EXIT%"=="0" echo Setup did not finish. Fix the error above and run setup.bat again.
pause
exit /b %SETUP_EXIT%
