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
(For End Users)

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
We provide pre-built versions for Chrome and Firefox to handle their different manifest requirements (Service Workers vs. Event Pages).

d.  **Chrome / Edge / Brave**:
    1.  Navigate to `chrome://extensions`.
    2.  Enable **Developer Mode**.
    3.  Click **Load Unpacked**.
    4.  Select the `dist/chrome` folder.

e.  **Firefox / LibreWolf**:
    1.  Navigate to `about:debugging#/runtime/this-firefox`.
    2.  Click **Load Temporary Add-on...**.
    3.  Select any file inside the `dist/firefox` folder.

### 3. Connect your AI
Add the MCP server to your AI agent configuration (e.g., Claude Desktop config or custom MCP client).

**Basic Configuration (Default Port 8765):**
*(Windows)*
```json
{
  "mcpServers": {
    "uplink": {
      "command": "f:/browser-tool/start_server.bat",
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
      "command": "/path/to/browser-tool/start_server.sh",
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
      "command": "f:/browser-tool/start_server.bat",
      "args": ["--port", "8766"]
    }
  }
}
```
*Note: If you change the server port, remember to update the **Server Port** setting in the Browser Extension Dashboard to match.*
*Note on Scripts: The provided `start_server` scripts are designed to simply launch the Python process. For multi-agent setups, we disabled the auto-kill feature so multiple instances can run side-by-side.*

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
You can run multiple instances of the server on different ports to power multiple agents simultaneously.

```bash
# Start server on port 8766
python server.py --port 8766
```

Then in the **Extension Dashboard**, enter `8766` in the Port field to connect the specific browser window to that agent.

### Custom Download Directory
Keep your focused workspace clean by directing all media (screenshots, recordings) to a specific folder.

```bash
# Save files to ./media/
python server.py --downloads "./media"
```
*Note: The tool returns clickable `file:///` links for easy access.*

## 🎥 Video Recording
*   **Supported Browsers**: Chrome, Edge, Brave (Chromium-based).
*   **Unsupported**: Firefox, LibreWolf (Due to missing `offscreen` API).
*   **Usage**: The `start_recording` tool captures the active tab's video and audio.

## ✍️ Rich Text Support
Uplink includes a smart typing tool that handles:
*   **Standard Forms**: `<input>`, `<textarea>`.
*   **Rich Text Editors**: `contenteditable` divs (e.g., **X.com**, **Notion**), simulating real keystrokes.

## 🌐 Multi-Browser Support

Uplink supports having the extension installed in multiple browsers (e.g., Chrome, Edge, Firefox) simultaneously, but **only one browser can be connected to the AI at a time**.

**How to manage connections:**
1.  **Dashboard Status**: The extension popup shows a status badge (Green for **Connected**, Red for **Disconnected**).
2.  **Toggle Connection**: Click the badge to manually Connect or Disconnect that specific browser.
3.  **Last One Wins**: If you open a new browser or reload the extension, it will automatically claim the connection, disconnecting any other active browser.
4.  **Exclusive Control**: The AI will only send commands (navigation, clicks, etc.) to the currently connected browser. The disconnected browser will remain completely passive.

---
*Created by HackAfterDark*

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
