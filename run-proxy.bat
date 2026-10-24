@echo off
setlocal

cd /d "%~dp0"
if exist "%~dp0.venv\Scripts\python.exe" (
    "%~dp0.venv\Scripts\python.exe" -m proxy.launcher %*
    goto done
)
if exist "%~dp0venv\Scripts\python.exe" (
    "%~dp0venv\Scripts\python.exe" -m proxy.launcher %*
    goto done
)
where py >nul 2>nul
if not errorlevel 1 (
    py -3 -m proxy.launcher %*
    goto done
)
python -m proxy.launcher %*

:done
set "PROXY_EXIT=%errorlevel%"
if not "%PROXY_EXIT%"=="0" pause
exit /b %PROXY_EXIT%
