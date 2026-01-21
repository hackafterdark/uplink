@echo off
rem Removed global taskkill to allow multiple server instances

rem Switch to script directory
pushd "%~dp0"

rem Check for virtual environment
if not exist "%~dp0venv" (
    echo Creating virtual environment... 1>&2
    python -m venv "%~dp0venv" 1>&2
)

rem Activate virtual environment
call "%~dp0venv\Scripts\activate.bat"

rem Install dependencies (quietly)
echo Installing dependencies... 1>&2
python -m pip install -q -r "%~dp0requirements.txt" 1>&2

rem Run the server
echo Starting Uplink Server... 1>&2
python "%~dp0server.py" %*
