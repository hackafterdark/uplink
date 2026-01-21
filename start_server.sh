#!/bin/bash

# Uplink Server Startup Script (macOS / Linux)

# Ensure we are in the script's directory so relative paths work
cd "$(dirname "$0")" || exit

echo "Stopping any existing Uplink server instances..."
# Kill processes matching "server.py" to release the port
# pkill -f "python.*server.py" 2>/dev/null

echo "Starting Uplink Server..."

# Detect Python command
if command -v python3 &>/dev/null; then
    PYTHON_CMD=python3
else
    PYTHON_CMD=python
fi

# Check for virtual environment
VENV_DIR="venv"
if [ ! -d "$VENV_DIR" ]; then
    echo "Creating virtual environment..." >&2
    $PYTHON_CMD -m venv "$VENV_DIR" >&2
fi

# Activate virtual environment
source "$VENV_DIR/bin/activate"

# Install dependencies (quietly) inside venv
echo "Installing dependencies..." >&2
pip install -q -r requirements.txt >&2

# Run the server
echo "Starting Uplink Server..." >&2
python server.py "$@"
