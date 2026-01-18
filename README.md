# Uplink: The AI Browser Bridge 🛰️

**Uplink** (formerly Browser Bridge) is a powerful tool that connects your local AI agents to your web browser. It acts as a bridge, allowing AI models (via the Model Context Protocol - MCP) to read, control, and interact with the open web just like a human user.

## 🚀 What is Uplink?

Uplink allows your AI coding assistant or agent to:
*   **See** what you see (Read page content, take screenshots).
*   **Interact** with websites (Click, Type, Submit forms).
*   **Debug** web applications (Read Console logs, LocalStorage).
*   **Record** your sessions (Video recording via `tabCapture`).
*   **Automate** complex workflows across multiple tabs and frames.

It consists of two parts:
1.  **Python MCP Server**: Runs locally, exposing "Tools" to your AI.
2.  **Browser Extension**: Connects to the server via WebSocket to execute commands in Chrome/Edge/Brave.

## ✨ Key Features

*   **Complete DOM Control**: `click`, `type`, `execute_script`, `get_html`.
*   **Multi-Frame Support**: Automatically finds elements inside `<iframe>`s.
*   **Visual Feedback**: Highlights elements before clicking or typing so you see what the AI is doing.
*   **Security First**:
    *   **Panic Button**: Instantly block all AI commands from the dashboard.
    *   **User Blocklist**: Prevent the AI from visiting specific domains (e.g., `*bank.com`).
    *   **Rate Limiting**: Configurable delay to prevent bot detection.
    *   **Secure Logging**: Sensitive input (like passwords) is automatically redacted from logs.
    *   **Hardcoded Safety**: Blocks access to `chrome://` and `file://` (unless enabled).
*   **Cross-Platform**: Works on Windows, macOS, and Linux.

## 🛠️ Installation

### 1. Start the MCP Server
You need Python 3.10+ installed.

```bash
# Install dependencies
pip install -r requirements.txt

# Start the server
# Windows:
./start_server.bat

# macOS / Linux:
./start_server.sh
```

The server will start on `ws://127.0.0.1:8765`.

### 2. Install the Extension
1.  Open your browser (Chrome, Edge, Brave, etc.).
2.  Navigate to `chrome://extensions`.
3.  Enable **Developer Mode** (top right).
4.  Click **Load Unpacked**.
5.  Select the `extension/` folder inside this project.

### 3. Connect your AI
Add the MCP server to your AI agent configuration (e.g., Claude Desktop config):

```json
{
  "mcpServers": {
    "uplink": {
      "command": "python",
      "args": ["/path/to/uplink/server.py"]
    }
  }
}
```

## 🛡️ Security

Uplink gives an AI control over your browser, so security is paramount.
*   **Local Only**: The server binds to `127.0.0.1`, preventing network access.
*   **Token Auth**: Requires a specific token to connect to the WebSocket.
*   **Privacy**: Passwords are redacted from logs.
*   **Control**: You can toggle "Allow Local Files" and manage blocked domains directly from the extension dashboard.

## 🎮 Dashboard

Click the extension icon to open the **Uplink Control** dashboard.
*   **Activity Log**: See exactly what the AI is doing in real-time.
*   **Panic Button**: Stop the AI immediately.
*   **Security Settings**: Configure rate limits and blocklists.

---
*Created by HackAfterDark*
