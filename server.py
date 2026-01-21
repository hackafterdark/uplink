from mcp.server.fastmcp import FastMCP
import asyncio
import websockets
import json
import base64

import os
import argparse
import pathlib
from datetime import datetime
from contextlib import asynccontextmanager
from typing import Optional


import logging

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler("server.log", encoding='utf-8', mode='a'),
        logging.StreamHandler()
    ],
    force=True
)

# Redirect stderr to logging
import sys
class StreamToLogger(object):
   def __init__(self, logger, log_level=logging.ERROR):
      self.logger = logger
      self.log_level = log_level
      self.linebuf = ''
   def write(self, buf):
      for line in buf.rstrip().splitlines():
         self.logger.log(self.log_level, line.rstrip())
   def flush(self):
      pass
sys.stderr = StreamToLogger(logging.getLogger('STDERR'), logging.ERROR)

# Global state
browser_socket = None
# A simple way to map requests to responses would be better, but for V1 we'll use a lock
# to ensure one tool call -> one response flow.
socket_lock = asyncio.Lock()

# Auth Token (Hardcoded for V1, User can change)
AUTH_TOKEN = "mcp-browser-bridge-secret"

# --- WebSocket Server ---
async def handler(websocket):
    global browser_socket
    
    # Check Token
    try:
        path = websocket.request.path
    except AttributeError:
        # Fallback for older legacy versions if any
        path = getattr(websocket, 'path', '')
        
    logging.info(f"Incoming connection path: {path}") # DEBUG LOG
    if f"token={AUTH_TOKEN}" not in path:
        logging.error(f"Unauthorized connection attempt from {websocket.remote_address}. Path: {path}")
        await websocket.close(code=1008, reason="Unauthorized")
        return

    logging.info(f"New connection from {websocket.remote_address}")
    async with socket_lock:
        if browser_socket is not None:
            logging.info("Closing existing connection to accept new one...")
            try:
                # Add timeout to prevent hanging if the client is unresponsive
                await asyncio.wait_for(browser_socket.close(1001, "New connection takeover"), timeout=2.0)
            except asyncio.TimeoutError:
                logging.warning("Timed out waiting for old connection to close cleanly")
            except Exception as e:
                logging.error(f"Error closing old connection: {e}")
        browser_socket = websocket
    logging.info("🌍 Browser Connected!")
    try:
        await websocket.wait_closed()
    except Exception as e:
        logging.error(f"WebSocket Error: {e}")
    finally:
        # Log why it closed
        logging.info(f"Closed: code={websocket.close_code}, reason={websocket.close_reason}")
        async with socket_lock:
            if browser_socket == websocket:
                browser_socket = None
        logging.info("❌ Browser Disconnected")

# (Removed redundant/misplaced arg parsing block)

# (Removed redundant code)

# Re-doing arg parsing block for clarity since we are adding more args
parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=8765, help="WebSocket server port")
parser.add_argument("--downloads", type=str, default=None, help="Directory to save downloads")
args, unknown = parser.parse_known_args()

PORT = args.port
DOWNLOAD_DIR = args.downloads

# Fallback loose port logic (same as before)
if PORT == 8765 and unknown:
    for arg in unknown:
        try:
            val = int(arg)
            if 1024 < val < 65536:
                PORT = val
                break
        except ValueError:
            pass

if not DOWNLOAD_DIR:
    DOWNLOAD_DIR = os.environ.get("UPLINK_DOWNLOAD_DIR", os.getcwd())

if not os.path.isabs(DOWNLOAD_DIR):
    DOWNLOAD_DIR = os.path.abspath(DOWNLOAD_DIR)

# Create dir if not exists
os.makedirs(DOWNLOAD_DIR, exist_ok=True)
logging.info(f"Downloads directory set to: {DOWNLOAD_DIR}")

import subprocess

def kill_port_process(port):
    """
    Kills any process listening on the specified port.
    Cross-platform: Windows (netstat/taskkill), Unix (lsof/kill).
    """
    logging.info(f"Checking for processes on port {port}...")
    try:
        if sys.platform == 'win32':
             # Windows: netstat -> find PID -> taskkill
             # "netstat -aon" output format:
             # TCP    0.0.0.0:8765           0.0.0.0:0              LISTENING       1234
             # We look for :<port> and LISTENING
             cmd = 'netstat -aon'
             output = subprocess.check_output(cmd, shell=True).decode()
             for line in output.splitlines():
                 if f":{port}" in line and "LISTENING" in line:
                     parts = line.split()
                     pid = parts[-1] # PID is the last element
                     logging.warning(f"Port {port} is busy. Killing PID {pid}...")
                     subprocess.run(f"taskkill /F /PID {pid}", shell=True, stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
        else:
             # Unix: lsof -> kill
             cmd = f"lsof -ti:{port}"
             try:
                 output = subprocess.check_output(cmd.split()).decode().strip()
                 if output:
                     pids = output.split()
                     for pid in pids:
                         logging.warning(f"Port {port} is busy. Killing PID {pid}...")
                         os.kill(int(pid), 9) 
             except subprocess.CalledProcessError:
                 pass # No process found
    except Exception as e:
        logging.error(f"Error trying to free port {port}: {e}")

async def start_ws():
    # Try to free the port first
    kill_port_process(PORT)
    
    logging.info(f"Starting WebSocket server on port {PORT} (ws://127.0.0.1:{PORT})...")
    print(f"DEBUG: Attempting to start WebSocket server on port {PORT}...")
    
    max_retries = 5
    for attempt in range(max_retries):
        try:
            # Aggressive keep-alive (5s ping) to keep Service Worker alive
            # websockets.serve sets reuse_address=True by default on most platforms
            async with websockets.serve(handler, "127.0.0.1", PORT, ping_interval=5, ping_timeout=10):
                print(f"DEBUG: WebSocket server running on ws://127.0.0.1:{PORT}")
                logging.info("WebSocket server started successfully")
                await asyncio.Future()  # Run forever
            return # Should not be reached unless cancelled
            
        except OSError as e:
            if e.errno == 10048 or e.errno == 98: # Address already in use
                if attempt < max_retries - 1:
                    msg = f"Port {PORT} is busy (attempt {attempt+1}/{max_retries}). Retrying in 1s..."
                    print(msg)
                    logging.warning(msg)
                    await asyncio.sleep(1)
                    continue
                else:
                    msg = f"ERROR: Port {PORT} is still in use after {max_retries} attempts. giving up."
                    logging.error(msg)
                    raise
            else:
                logging.error(f"Failed to start WebSocket server: {e}")
                raise
        except Exception as e:
            logging.error(f"CRITICAL ERROR: {e}")
            raise

# --- Watchdog ---
async def monitor_parent_process():
    """
    Monitors the parent process. If it dies, we die.
    Essential for Windows where 'cmd.exe' wrapper might die but 'python.exe' persists.
    """
    try:
        if sys.platform == 'win32':
            import ctypes
            # Get parent process ID
            ppid = os.getppid()
            logging.info(f"Watchdog active. Monitoring Parent PID: {ppid}")
            
            kernel32 = ctypes.windll.kernel32
            SYNCHRONIZE = 0x00100000
            
            while True:
                # Open process with SYNCHRONIZE access
                handle = kernel32.OpenProcess(SYNCHRONIZE, False, ppid)
                if not handle:
                    logging.warning("Watchdog: Parent process handle invalid. Assuming parent died.")
                    break
                
                # Check exit code (STILL_ACTIVE = 259)
                exit_code = ctypes.c_ulong()
                kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))
                kernel32.CloseHandle(handle)
                
                if exit_code.value != 259:
                     logging.warning(f"Watchdog: Parent exited with code {exit_code.value}. Terminating server.")
                     break
                     
                await asyncio.sleep(2) # Check every 2s
        else:
            # Unix-like (easier)
            ppid = os.getppid()
            logging.info(f"Watchdog active. Monitoring Parent PID: {ppid}")
            while True:
                try:
                    os.kill(ppid, 0) # Signal 0 checks existence
                    await asyncio.sleep(2)
                except OSError:
                    logging.warning("Watchdog: Parent process died. Terminating server.")
                    break
                    
    except Exception as e:
        logging.error(f"Watchdog Error: {e}")
    
    # If we break loop, suicide
    logging.error("💀 Parent died. Watchdog triggering self-termination.")
    os._exit(0) # Force hard exit

# --- MCP Lifecycle ---
@asynccontextmanager
async def lifespan(server):
    logging.info("Starting MCP Server...")
    ws_task = asyncio.create_task(start_ws())
    # watchdog_task = asyncio.create_task(monitor_parent_process()) # Disabled: False positives on Windows wrappers
    yield
    ws_task.cancel()
    # watchdog_task.cancel()
    try:
        await ws_task
        # await watchdog_task
    except asyncio.CancelledError:
        pass

mcp = FastMCP("BrowserBridge", lifespan=lifespan)

# --- Helpers ---
async def send_command(command: dict) -> str:
    """Sends a JSON command to the browser and waits for a response."""
    global browser_socket
    
    # 1. Wait for connection (Handle Race Condition on Restart)
    if not browser_socket:
        logging.info("Browser not connected. Waiting up to 15s for connection...")
        for i in range(30): # 30 * 0.5s = 15s wait
            if browser_socket:
                logging.info("Browser connected! Proceeding...")
                break
            await asyncio.sleep(0.5)
            
    if not browser_socket:
        logging.error("Attempted command but browser_socket is None after wait")
        return "Error: Browser not connected. Please ensure the extension is installed and active, then try again."
    
    async with socket_lock:
        try:
            logging.info(f"Sending command: {command}")
            await browser_socket.send(json.dumps(command))
            logging.info("Waiting for response...")
            
            # Wait for response with a timeout to prevent deadlocks
            try:
                response = await asyncio.wait_for(browser_socket.recv(), timeout=60.0)
                logging.info(f"Received response: {response[:100]}...")
                
                # Handle debug messages from extension
                try:
                    data = json.loads(response)
                    if isinstance(data, dict) and "debug" in data:
                        logging.info(f"EXTENSION DEBUG: {data['debug']}")
                        # Keep waiting for the real response? 
                        # This is complex with a single recv(). 
                        # For now, just return it and let the tool handle (or fail).
                        return response 
                except:
                    pass
                    
                return response
            except asyncio.TimeoutError:
                logging.error("Timeout waiting for browser response")
                return "Error: Timeout waiting for browser response"
                
        except Exception as e:
            logging.error(f"Error in send_command: {e}")
            return f"Error communicating with browser: {str(e)}"

# --- Tools ---

@mcp.tool()
async def read_page(format: str = "distilled") -> str:
    """
    Returns the page content.
    ARGUMENTS:
        format: 'distilled' (default), 'text', or 'html'.
        - 'distilled': A simplified map of interactive elements [ID] <tag> "Label".
                       Use this to get numeric IDs for interaction.
        - 'text': Raw text content of the page.
        - 'html': The outerHTML of the document.
    """
    return await send_command({"action": "read", "format": format})

@mcp.tool()
async def click_element(selector: str, purpose: str = "") -> str:
    """Clicks an element.
    ARGUMENTS:
        selector: The numeric ID from read_page (e.g., "42") OR a CSS selector.
                  ALWAYS prefer using the numeric ID if available from the 'distilled' view.
        purpose: Optional label to show on the highlight overlay."""
    # 1. Highlight
    await send_command({
        "action": "highlight",
        "selector": selector,
        "label": purpose
    })
    await asyncio.sleep(0.5) # Brief pause for visibility
    
    # 2. Click
    return await send_command({"action": "click", "selector": selector})

@mcp.tool()
async def type_text(selector: str, text: str) -> str:
    """Types text into an element defined by a CSS selector."""
    # 1. Highlight
    await send_command({
        "action": "highlight",
        "selector": selector,
        "label": f"Typing: {text}"
    })
    
    return await send_command({
        "action": "type",
        "selector": selector,
        "text": text
    })

@mcp.tool()
async def press_key(key: str, selector: str = None) -> str:
    """Presses a key on the page or on a specific element.
    ARGUMENTS:
        key: The key to press (e.g., 'Enter', 'ArrowDown', 'Backspace', 'a', 'b').
        selector: Optional. If provided, the key press is dispatched to this element.
                  Otherwise, it is dispatched to the document/body.
    """
    return await send_command({
        "action": "press_key",
        "key": key,
        "selector": selector
    })

@mcp.tool()
async def semantic_find(query: str) -> str:
    """Finds an element using natural language search (Tiny AI).
    Useful when you know WHAT you want (e.g. "Login button") but not the ID.
    Returns the numeric ID of the best match.
    """
    return await send_command({
        "action": "semantic_find",
        "query": query
    })



@mcp.tool()
async def get_extension_status() -> str:
    """Checks the status of the extension and AI model."""
    return await send_command({"action": "get_status"})

@mcp.tool()
async def hover_element(selector: str) -> str:
    """Hovers over an element defined by a CSS selector."""
    return await send_command({
        "action": "hover",
        "selector": selector
    })

@mcp.tool()
async def select_option(selector: str, value: str) -> str:
    """Selects an option in a <select> element by its value."""
    return await send_command({
        "action": "select_option",
        "selector": selector,
        "value": value
    })

@mcp.tool()
async def execute_script(script: str) -> str:
    """Executes arbitrary JavaScript in the active tab context. 
    The script should return a value."""
    return await send_command({
        "action": "execute",
        "script": script
    })

@mcp.tool()
async def open_tab(url: str) -> str:
    """Opens a new browser tab with the specified URL."""
    return await send_command({
        "action": "open_tab",
        "url": url
    })

@mcp.tool()
async def navigate(url: str) -> str:
    """Navigates the active tab to a new URL and waits for the page to load."""
    return await send_command({
        "action": "navigate",
        "url": url
    })

@mcp.tool()
async def go_back() -> str:
    """Navigates back in the browser history."""
    return await send_command({"action": "go_back"})

@mcp.tool()
async def go_forward() -> str:
    """Navigates forward in the browser history."""
    return await send_command({"action": "go_forward"})

@mcp.tool()
async def reload_page() -> str:
    """Reloads the current page."""
    return await send_command({"action": "reload_page"})

@mcp.tool()
async def set_viewport(width: int, height: int) -> str:
    """Resizes the browser window to the specified dimensions."""
    return await send_command({
        "action": "set_viewport",
        "width": width,
        "height": height
    })

@mcp.tool()
async def scroll_page(direction: str = "down") -> str:
    """Scrolls the page. Directions: 'up', 'down', 'top', 'bottom'."""
    return await send_command({
        "action": "scroll_page",
        "direction": direction
    })

@mcp.tool()
async def scroll_into_view(selector: str) -> str:
    """Scrolls an element into view. Accepts a CSS selector or numeric ID."""
    return await send_command({
        "action": "scroll_into_view",
        "selector": selector
    })

@mcp.tool()
async def get_console_logs() -> str:
    """Retrieves captured console logs from the browser extension."""
    return await send_command({"action": "get_logs"})

# @mcp.tool()
# async def get_network_traffic(count: int = 20) -> str:
#     """Retrieves recent network traffic (fetch/xhr) from the browser. 
#     Returns the last 'count' requests (default 20).
#     Captures method, URL, status, and response bodies for text/json content."""
#     return await send_command({
#         "action": "get_network_traffic",
#         "count": count
#     })

@mcp.tool()
async def wait_for_element(selector: str, timeout: int = 15000) -> str:
    """Waits for an element to appear in the DOM. Essential for React/SPA apps."""
    return await send_command({
        "action": "wait_for",
        "selector": selector,
        "timeout": timeout
    })

@mcp.tool()
async def get_html(selector: str) -> str:
    """Returns the outerHTML of an element. Useful for inspecting attributes (data-testid)."""
    return await send_command({
        "action": "get_html",
        "selector": selector
    })

@mcp.tool()
async def get_local_storage(key: str) -> str:
    """Retrieves a value from the page's localStorage."""
    return await send_command({
        "action": "get_storage",
        "storageType": "local",
        "key": key
    })

@mcp.tool()
async def get_session_storage(key: str) -> str:
    """Retrieves a value from the page's sessionStorage."""
    return await send_command({
        "action": "get_storage",
        "storageType": "session",
        "key": key
    })

@mcp.tool()
async def set_local_storage(key: str, value: str) -> str:
    """Sets a value in the page's localStorage."""
    return await send_command({
        "action": "set_storage",
        "storageType": "local",
        "key": key,
        "value": value
    })

@mcp.tool()
async def clear_local_storage() -> str:
    """Clears all data from the page's localStorage."""
    return await send_command({
        "action": "clear_storage",
        "storageType": "local"
    })

@mcp.tool()
async def get_cookies() -> str:
    """Returns all cookies for the current page (document.cookie). 
    Note: HttpOnly cookies are not visible."""
    return await send_command({"action": "get_cookies"})

@mcp.tool()
async def set_cookie(name: str, value: str) -> str:
    """Sets a cookie using document.cookie."""
    return await send_command({
        "action": "set_cookie",
        "name": name,
        "value": value
    })

@mcp.tool()
async def get_page_metadata() -> str:
    """Returns metadata for the active page (title, description, image, etc)."""
    return await send_command({"action": "get_metadata"})

@mcp.tool()
async def read_as_markdown() -> str:
    """Converts the active page's HTML content to Markdown. 
    Useful for LLM contexts and RAG."""
    # The conversion now happens in the browser extension to avoid
    # transferring massive HTML strings which can crash the browser/connection.
    return await send_command({"action": "read_as_markdown"})

@mcp.tool()
async def screenshot(save_path: str = None) -> str:
    """Takes a screenshot. 
    save_path: File path. If None, generates a timestamped filename (e.g., 'screenshot_20240101_120000.png')."""
    
    # Generate timestamped default if no path provided
    if not save_path:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        save_path = f"screenshot_{timestamp}.png"
        
    response = await send_command({"action": "screenshot"})
    
    if response.startswith("Error"):
        return response
        
    try:
        # Expected format: "data:image/png;base64,..."
        if "base64," in response:
            header, encoded = response.split("base64,", 1)
            data = base64.b64decode(encoded)
            
            # Resolve path: 
            # 1. Use absolute path if provided.
            # 2. Else use DOWNLOAD_DIR
            
            if os.path.isabs(save_path):
                full_path = save_path
            else:
                full_path = os.path.join(DOWNLOAD_DIR, save_path)
            
            # Create dir if needed
            os.makedirs(os.path.dirname(full_path), exist_ok=True)
            
            with open(full_path, "wb") as f:
                f.write(data)
                
            # Return clickable URI
            file_uri = pathlib.Path(full_path).as_uri()
            return f"Screenshot saved: [{os.path.basename(full_path)}]({file_uri})"
        else:
            return "Error: Unexpected response format from browser screenshot."
    except Exception as e:
        return f"Error saving screenshot: {str(e)}"

@mcp.tool()
async def start_recording() -> str:
    """Starts video recording of the active tab."""
    return await send_command({"action": "start_recording"})

@mcp.tool()
async def stop_recording(save_path: str = None) -> str:
    """Stops the video recording and saves it.
    save_path: File path. If None, generates a timestamped filename."""
    
    # Generate timestamped default if no path provided
    if not save_path:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        save_path = f"recording_{timestamp}.webm"
        
    # This expects the browser to send back the binary data or a large data URL
    # For a robust implementation, we might need chunking, but for V1:
    response = await send_command({"action": "stop_recording"})
    
    if response.startswith("Error"):
        return response
        
    try:
        # Assuming response is a data URL: "data:video/webm;base64,....."
        if "base64," in response:
            header, encoded = response.split("base64,", 1)
            data = base64.b64decode(encoded)
            
            # Resolve path: 
            # 1. Use absolute path if provided.
            # 2. Else use DOWNLOAD_DIR
            
            if os.path.isabs(save_path):
                full_path = save_path
            else:
                full_path = os.path.join(DOWNLOAD_DIR, save_path)
            
            # Ensure safe extension
            if not full_path.endswith(".webm"):
                full_path += ".webm"
                
            # Create dir if needed
            os.makedirs(os.path.dirname(full_path), exist_ok=True)
            
            with open(full_path, "wb") as f:
                f.write(data)
                
            # Return clickable URI
            file_uri = pathlib.Path(full_path).as_uri()
            return f"Recording saved: [{os.path.basename(full_path)}]({file_uri})"
        else:
            return "Error: Unexpected response format from browser recording."
    except Exception as e:
        return f"Error saving recording: {str(e)}"


@mcp.tool()
async def get_page_performance():
    """
    Returns performance metrics for the current page.
    Includes:
    - Navigation Timing (TTFB, Load Time)
    - Paint Timing (First Contentful Paint)
    - Slow Resources (Top 5 bottlenecks)
    - Recent Interaction Timings (Click/Type duration)
    """
    raw_response = await send_command({"action": "get_performance_metrics"})
    
    try:
        result = json.loads(raw_response)
    except:
        return f"Error parsing response: {raw_response}"

    if "error" in result:
        return f"Error getting performance metrics: {result['error']}"
    
    # Format the report
    nav = result.get('navigation', {})
    fcp = result.get('fcp', 0)
    slow = result.get('slowResources', [])
    last = result.get('lastInteraction', {})
    long_tasks = result.get('longTaskCount', 0)

    report = [
        "## Page Performance Report",
        f"- **TTFB (Backend)**: {nav.get('ttfb', 0)}ms",
        f"- **FCP (Visual)**: {fcp}ms",
        f"- **Page Load**: {nav.get('pageLoad', 0)}ms",
        f"- **DOM Processing**: {nav.get('domProcessing', 0)}ms",
        "",
        "### Recent Interaction",
        f"- **Last Action**: {last.get('type', 'None')}",
        f"- **Duration**: {last.get('duration', 0)}ms",
        f"- **Long Tasks (10s)**: {long_tasks}",
        "",
        "### Top Slow Resources (>500ms)"
    ]

    if not slow:
        report.append("- (None)")
    else:
        for r in slow:
            report.append(f"- [{r.get('type')}] {r.get('name')} ({r.get('duration')}ms)")

    return "\n".join(report)

@mcp.tool()
async def check_errors() -> str:
    """Analyzes browser console errors and network failures from the active page.
    Returns a clustered summary of issues, intelligently grouping similar errors to reduce noise.
    Useful for diagnosing broken pages or failed actions."""
    return await send_command({"action": "check_errors"})

@mcp.tool()
async def manage_session(action: str = "clear") -> str:
    """Manages the browser session state (cookies, local storage, logs).
    ARGUMENTS:
        action: 'clear' (default) - Clears all storage, cookies, and error logs.
        action: 'clear_logs' - Clears only the error logs.
    """
    return await send_command({
        "action": "manage_session",
        "command": action
    })

@mcp.tool()
async def audit_accessibility() -> str:
    """
    Checks the current page for accessibility violations using axe-core.
    Returns a summarized markdown report of violations with Numeric IDs for elements.
    """
    raw_response = await send_command({"action": "audit_accessibility"})
    
    try:
        result = json.loads(raw_response)
    except:
        return f"Error parsing response: {raw_response}"

    if "error" in result:
        return f"Error: {result['error']}"

    violations = result.get('violations', [])
    if not violations:
        return "## Accessibility Audit\n✅ No violations found!"

    report = ["## Accessibility Audit", f"Found {len(violations)} types of violations.", ""]
    
    for v in violations:
        report.append(f"### {v['id'].upper()} ({v['impact']})")
        report.append(f"**Description**: {v['description']}")
        report.append("**Affected Elements:**")
        for node in v.get('nodes', []):
            mcp_id = node.get('mcpId', 'N/A')
            report.append(f"- [ID: {mcp_id}] `{node['html']}`")
            report.append(f"  * Fix: {node['failureSummary']}")
        report.append("")

    report.append(f"Summary: {result.get('passesCount', 0)} checks passed, {result.get('incompleteCount', 0)} checks need manual review.")
    return "\n".join(report)
def main():
    mcp.run()

if __name__ == "__main__":
    main()
