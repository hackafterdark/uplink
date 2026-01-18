from mcp.server.fastmcp import FastMCP
import asyncio
import websockets
import json
import base64
import base64
import os
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
        if browser_socket is not None and browser_socket.open:
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

# --- CLI Args ---
import argparse
parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=8765, help="WebSocket server port")
# Use parse_known_args to avoid conflict with MCP's own CLI args if any
args, unknown = parser.parse_known_args()
PORT = args.port

# Fallback: If port is still default, check if user passed a bare number in args (e.g. ["8766"] or ["port", "8766"])
if PORT == 8765 and unknown:
    for arg in unknown:
        try:
            val = int(arg)
            if 1024 < val < 65536:
                PORT = val
                logging.info(f"Found loose port argument: {PORT}")
                break
        except ValueError:
            pass

async def start_ws():
    logging.info(f"Starting WebSocket server on port {PORT} (ws://127.0.0.1:{PORT})...")
    # Aggressive keep-alive (5s ping) to keep Service Worker alive
    async with websockets.serve(handler, "127.0.0.1", PORT, ping_interval=5, ping_timeout=10):
        await asyncio.Future()  # Run forever

# --- MCP Lifecycle ---
@asynccontextmanager
async def lifespan(server):
    logging.info("Starting MCP Server...")
    ws_task = asyncio.create_task(start_ws())
    yield
    ws_task.cancel()
    try:
        await ws_task
    except asyncio.CancelledError:
        pass

mcp = FastMCP("BrowserBridge", lifespan=lifespan)

# --- Helpers ---
async def send_command(command: dict) -> str:
    """Sends a JSON command to the browser and waits for a response."""
    global browser_socket
    if not browser_socket:
        logging.error("Attempted command but browser_socket is None")
        return "Error: Browser not connected. Please install the extension and reload the page."
    
    async with socket_lock:
        try:
            logging.info(f"Sending command: {command}")
            await browser_socket.send(json.dumps(command))
            logging.info("Waiting for response...")
            
            # Wait for response with a timeout to prevent deadlocks
            try:
                response = await asyncio.wait_for(browser_socket.recv(), timeout=30.0)
                logging.info(f"Received response: {response[:100]}...")
                return response
            except asyncio.TimeoutError:
                logging.error("Timeout waiting for browser response")
                return "Error: Timeout waiting for browser response"
                
        except Exception as e:
            logging.error(f"Error in send_command: {e}")
            return f"Error communicating with browser: {str(e)}"

# --- Tools ---

@mcp.tool()
async def read_page() -> str:
    """Returns the text content of the active tab."""
    return await send_command({"action": "read"})

@mcp.tool()
async def click_element(selector: str, purpose: str = "") -> str:
    """Clicks an element defined by a CSS selector. 
    'purpose' is an optional label to show on the highlight overlay."""
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
async def get_console_logs() -> str:
    """Retrieves captured console logs from the browser extension."""
    return await send_command({"action": "get_logs"})

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
            # 2. If relative, use UPLINK_DOWNLOAD_DIR env var if set.
            # 3. Fallback to CWD.
            
            if os.path.isabs(save_path):
                full_path = save_path
            else:
                base_dir = os.environ.get("UPLINK_DOWNLOAD_DIR", os.getcwd())
                full_path = os.path.join(base_dir, save_path)
            
            # Create dir if needed
            os.makedirs(os.path.dirname(full_path), exist_ok=True)
            
            with open(full_path, "wb") as f:
                f.write(data)
            return f"Screenshot saved to {full_path}"
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
            # 2. If relative, use UPLINK_DOWNLOAD_DIR env var if set.
            # 3. Fallback to CWD.
            
            if os.path.isabs(save_path):
                full_path = save_path
            else:
                base_dir = os.environ.get("UPLINK_DOWNLOAD_DIR", os.getcwd())
                full_path = os.path.join(base_dir, save_path)
            
            # Ensure safe extension
            if not full_path.endswith(".webm"):
                full_path += ".webm"
                
            # Create dir if needed
            os.makedirs(os.path.dirname(full_path), exist_ok=True)
            
            with open(full_path, "wb") as f:
                f.write(data)
            return f"Recording saved to {full_path}"
        else:
            return "Error: Unexpected response format from browser recording."
    except Exception as e:
        return f"Error saving recording: {str(e)}"

if __name__ == "__main__":
    mcp.run()
