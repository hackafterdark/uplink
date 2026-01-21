# Uplink: The AI Browser Bridge 🛰️

**Uplink** is a powerful tool that connects your local AI agents to your web browser. It acts as a bridge, allowing AI models (via the Model Context Protocol - MCP) to read, control, and interact with the open web just like a human user.

## 🚀 What is Uplink?

Uplink allows your AI coding assistant or agent to:
*   **See** what you see (Read page content, take screenshots).
*   **Interact** with websites (Click, Type, Submit forms).
*   **Debug** web applications (Read Console logs, LocalStorage).
*   **Record** your sessions (Video recording via `tabCapture`).
*   **Automate** complex workflows across multiple tabs and frames.
*   **Scale** with Multi-Agent support (Run multiple independent browser sessions on different ports).

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

### 1. Download the Code
For now, until there is a stable release published, you need to download the source code:
*   **Clone the repository**: `git clone https://github.com/hackafterdark/uplink.git`
*   **Or**: Download the [latest ZIP](https://github.com/hackafterdark/uplink/archive/refs/heads/main.zip) and extract it.

Put this code in a directory of your choice, but remember where you put it because you'll need to configure your AI agent to point to the correct path.

### 2. Setup the MCP Server
You only need **Python 3.10+** installed. The provided startup scripts handle everything else (creating a virtual environment and installing dependencies) automatically the first time they run.

> [!NOTE]
> You typically **do not need to run these scripts manually**. MCP-compatible applications (like Antigravity, Claude Desktop, Cursor, or Roo Code) will execute them for you based on your configuration.

### 3. Install the Extension
Pre-built versions for Chrome and Firefox are available in the `dist/` directory to handle their different manifest requirements (Service Workers vs. Event Pages).

**Chrome / Edge / Brave**:
  1.  Navigate to `chrome://extensions`.
  2.  Enable **Developer Mode**.
  3.  Click **Load Unpacked**.
  4.  Select the `dist/chrome` folder.

**Firefox / LibreWolf**:
  1.  Navigate to `about:debugging#/runtime/this-firefox`.
  2.  Click **Load Temporary Add-on...**.
  3.  Select any file inside the `dist/firefox` folder.

### 4. Connect your AI
Add the MCP server to your AI agent configuration (e.g., Claude Desktop config, Cursor, or Roo Code).

**Important**: The agent uses the `command` field to automatically launch the server and install dependencies. You do not need to run the scripts yourself.

**Basic Configuration (Default Port 8765):**
*(Windows)*
```json
{
  "mcpServers": {
    "uplink": {
      "command": "C:/path/to/uplink/start_server.bat",
      "args": []
    }
  }
}
```
*(macOS / Linux)*
```json
{
  "mcpServers": {
    "uplink": {
      "command": "/path/to/uplink/start_server.sh",
      "args": []
    }
  }
}
```

**Advanced Configuration (Custom Port):**
If you need to run multiple instances or avoid port conflicts, pass the `--port` argument.

```json
{
  "mcpServers": {
    "uplink-secondary": {
      "command": "C:/path/to/uplink/start_server.bat",
      "args": ["--port", "8766"]
    }
  }
}
```
*Note: If you change the server port, remember to update the **Server Port** setting in the Browser Extension Dashboard to match.*

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
*   **Media Capture**: Screenshots and video recording.
*   **Tools Documentation**: See [docs/TOOLS.md](docs/TOOLS.md) for a full list of available tools.

## 👥 Multi-Agent & Advanced Config

### Custom Port (Run Multiple Agents)
To run multiple independent agents, you can specify different ports in your MCP configuration:

```json
"uplink-researcher": {
  "command": "path/to/start_server.sh",
  "args": ["--port", "8766"]
}
```

Then, in the **Extension Dashboard** of the browser instance you want that agent to control, enter `8766` in the **Server Port** field.

### Custom Download Directory
You can redirect all media (screenshots, recordings) to a specific folder by adding the `--downloads` argument to your configuration:

```json
"args": ["--downloads", "/your/custom/path"]
```
*Note: The tool returns clickable `file:///` links for easy access.*

## 🌐 Multi-Browser Support

Uplink supports having the extension installed in multiple browsers (e.g., Chrome, Edge, Firefox) simultaneously. You can use this in two ways:

### 1. Sequential (One Agent, Multiple Browsers)
If you only have **one** AI agent running (one MCP server on port 8765), you can switch which browser it controls on the fly.

*   **Last One Wins**: If you open a new browser or reload the extension, it will automatically claim the connection, disconnecting the previous one.
*   **Exclusive Control**: The AI defaults to controlling the last "active" browser. You can manually click the **Status Badge** in the extension dashboard to disconnect/reconnect specific browsers.

### 2. Parallel (Multiple Agents, Multiple Browsers)
You can run multiple AI agents simultaneously, each controlling a different browser (e.g., one agent for research on Chrome, another for testing on Firefox).

1.  Start server A on port `8765` -> Connect Chrome (Default port).
2.  Start server B on port `8766` -> Connect Firefox (Update Port in Dashboard -> 8766).

This allows independent control of multiple browser sessions at the same time.

## 👨‍💻 Development & Building

The `extension/` directory contains the source code. However, Chrome and Firefox require different `manifest.json` configurations.

To avoid maintaining two separate codebases, we use a build script to generate the distribution folders.

**If you make changes to the source code:**
1.  Edit files in `extension/`.
2.  Run the build script:
    ```bash
    python build_package.py
    ```
3.  This will update:
    *   `dist/chrome` (Service Worker manifest)
    *   `dist/firefox` (Event Page manifest)
4.  Reload the extension in your browser to see changes.

## 🔍 Troubleshooting

Having trouble connecting? Follow these steps:

### 1. Check the Server Logs
The Python server logs everything to a file sitting next to `server.py`:
*   **File**: `server.log` (located in the same directory as the server)
*   **What to look for**: Check for `🌍 Browser Connected!` or `❌ Browser Disconnected`. If you see errors related to `AttributeError` or `websockets`, try updating your dependencies (`pip install -r requirements.txt`).

### 2. Check the Browser Logs
The extension has its own logs which can reveal communication or CSP issues:
1.  Open Chrome Extensions (`chrome://extensions`) or Firefox Debugging (`about:debugging`).
2.  Click on **Service Worker** (Chrome) or **Inspect** (Firefox) for the Uplink extension.
3.  Look for "Connected to MCP Server" or red error messages in the console.

### 3. Check for Port Conflicts
Only one server can listen on a port at a time. If the server fails to start, check if another instance is already running:

*   **Windows**:
    ```powershell
    netstat -ano | findstr :8765
    ```
*   **Linux / macOS**:
    ```bash
    lsof -i :8765
    ```
If a process is found, kill it or use a different port (e.g., `--port 8767`).

### 4. Common Fixes
*   **"Browser not connected"**: Ensure the extension dashboard shows a green "Connected" status. If it's red, check that the port in the dashboard matches your server's `--port`. 
*   **"Secure Token Active"**: If you manually edited `AUTH_TOKEN` in `server.py`, ensure the extension is also updated or reloaded.

---
## 📜 License
MIT License - See [LICENSE](LICENSE) for details.
