@echo off
rem Removed global taskkill to allow multiple server instances

rem Check for virtual environment
if not exist "%~dp0venv" (
    echo Creating virtual environment...
    python -m venv "%~dp0venv"
)

rem Activate virtual environment
call "%~dp0venv\Scripts\activate.bat"

rem Install dependencies (quietly)
echo Installing dependencies...
python -m pip install -q -r "%~dp0requirements.txt"

rem Run the server
echo Starting Uplink Server...
python "%~dp0server.py" %*
