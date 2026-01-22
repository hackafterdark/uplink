# Security & Privacy Architecture

Uplink is designed as a **local-first, security-conscious bridge** between your AI Agent (MCP Client) and your Web Browser. Because it gives an AI agent powerful control over your browser, multiple security layers are implemented to ensure you remain in control.

## 1. Authentication Handshake
The connection between the Python MCP Server and the Browser Extension is secured via a **Verification Token**.

*   **Mechanism:** WebSocket Handshake
*   **Token:** `mcp-browser-bridge-secret` (Default)
*   **Protection:** The extension will refuse to connect to the server, and the server will refuse to accept the extension, unless this token matches. 
*   **Risk Profile:** 
    *   **Default Token:** The default secret is public. This is generally acceptable for personal use because an attacker would need **code execution access** to your local machine (to connect to `localhost:8765`) to exploit it. If they already have that, they don't need this bridge to harm you.
    *   **Custom Token:** For enhanced security (e.g., shared machines), you can change this token.
        *   **How to Change:** You must modify the `AUTH_TOKEN` variable in `server.py` AND `extension/background.js`, then **run the build script** (`python build_package.py`) and reinstall the extension.
*   **Risk Mitigation:** preventing malicious local processes or websites from hijacking the Uplink port. Only the extension (which you install) has the secret.

## 2. Iframe Security Policy
Uplink respects modern browser security models by default, but provides a powerful "Breach Mode" for testing.

### Default State (Safe)
*   **Policy:** **Strict Browser Enforcement**.
*   **Behavior:** The extension does **NOT** modify any network headers.
*   **Effect:**
    *   **Same-Origin Iframes:** Allowed (e.g., `subdomain.app.com` framing `app.com` if configured by the server).
    *   **Cross-Origin Iframes:** Blocked (e.g., `malicious.com` framing `bank.com`).
    *   **Clickjacking Protection:** Active. `X-Frame-Options` and `Content-Security-Policy: frame-ancestors` are respected.

### Force Allow All Iframes (Insecure / Testing)
*   **Policy:** **Header Stripping**.
*   **Behavior:** The extension actively strips `X-Frame-Options` and `Content-Security-Policy` headers from **ALL** network responses.
*   **Effect:**
    *   **All Iframes Load:** Any site can frame any other site.
    *   **Use Case:** Allows the AI Agent to interact with embedded widgets (analytics, ads, cross-site tools) that are normally blocked by the browser.
    *   **RISK:** While this toggle is ON, your browser is vulnerable to Clickjacking attacks from *any* tab. **Use only while the Agent is working, then turn OFF.**

### Verification
You can use the provided test file to verify this behavior:
1.  Open [test_clickjacking.html](test_clickjacking.html) in your browser.
2.  **Toggle OFF:** The Google iframe should be **BLOCKED** (refused to connect).
3.  **Toggle ON:** The Google iframe should **LOAD**.

## 3. Local File Access
*   **Default:** **Disabled**.
*   **Control:** "Allow Local Files (file://)" toggle in Dashboard.
*   **Risk:** Granting an AI access to `file://` URLs allows it to read any file on your computer that the browser can display.
*   **Safeguard:** This permission is strictly opt-in and checks the extension's explicit permission state before executing `read_page` on a `file://` URL.

## 4. Panic Mode 🛑
*   **Concept:** A physical "Kill Switch" for the AI's control.
*   **Function:** When enabled in the Dashboard, the background script **rejects all incoming commands** from the MCP Server.
*   **Use Case:** If the Agent begins hallucinating, clicking rapidly, or navigating to unintended pages, flip this switch to instantly sever its control without closing your browser.

## 5. Data Privacy (Cookies & Storage)
*   **Control:** "Allow Data Access" toggle.
*   **Function:** Controls whether the `get_cookies` and `get_local_storage` tools are active.
*   **Default:** **Enabled** (Required for many login-gated tasks).
*   **Mitigation:** If you are using the Agent on sensitive sites (Banking, Health) and do not want it to extract session tokens, disable this toggle. The Agent can still click/navigate but cannot "steal" your session cookies.

## 6. Blocklist
*   **Function:** a User-defined list of domains (supports wildcards like `*.bank.com`).
*   **Behavior:** Any command attempting to navigate to or interact with a matched domain is rejected by the extension before execution.

## 7. Rate Limiting
*   **Control:** "Rate Limit (ms)" input in Dashboard.
*   **Default:** **500ms**.
*   **Function:** Enforces a minimum delay between consecutive commands executed by the extension.
*   **Benefit:** Prevents the AI from "clicking rapidly" or overwhelming pages with requests. If the AI sends commands faster than this limit, the extension queues or throttles them. You can increase this value (e.g., to 1000ms or 2000ms) to force the Agent to work at a more human, observable pace.

## Summary of Recommendations
| Setting | Recommended Default | When to Change |
| :--- | :--- | :--- |
| **Panic Mode** | **OFF** | Turn ON immediately if AI misbehaves. |
| **Local Files** | **OFF** | Turn ON only if asking AI to read local PDFs/HTML. |
| **Force Allow Iframes** | **OFF** | Turn ON only if AI cannot see content inside a specific widget. |
| **Data Access** | **ON** | Turn OFF for high-security banking/personal browsing sessions. |
| **Rate Limit** | **500ms** | Increase to slow down execution for safer observation. |
