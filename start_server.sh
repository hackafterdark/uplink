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

# Run the server
$PYTHON_CMD server.py "$@"
