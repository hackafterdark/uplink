#!/bin/bash

# Uplink Server Startup Script (macOS / Linux)

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
    echo "Creating virtual environment..."
    $PYTHON_CMD -m venv "$VENV_DIR"
fi

# Activate virtual environment
source "$VENV_DIR/bin/activate"

# Install dependencies (quietly) inside venv
echo "Installing dependencies..."
pip install -q -r requirements.txt

# Run the server
echo "Starting Uplink Server..."
python server.py "$@"
