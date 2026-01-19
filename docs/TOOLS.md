# Uplink Tool Reference

This document provides a comprehensive list of tools available in the Uplink MCP server.

## Navigation & Window Control

| Tool Name | Description | Arguments |
| :--- | :--- | :--- |
| `navigate` | Navigates the active tab to a new URL and waits for the page to load. (Subject to **Blocklist** and **Local File** settings) | `url` (str) |
| `open_tab` | Opens a new browser tab with the specified URL. | `url` (str) |
| `go_back` | Navigates back in the browser history. | None |
| `go_forward` | Navigates forward in the browser history. | None |
| `reload_page` | Reloads the current page. | None |
| `set_viewport` | Resizes the browser window to the specified dimensions. | `width` (int), `height` (int) |

## Interaction

| Tool Name | Description | Arguments |
| :--- | :--- | :--- |
| `click_element` | Clicks an element defined by a CSS selector. (Highlights before clicking) | `selector` (str), `purpose` (str, optional) |
| `type_text` | Types text into an element defined by a CSS selector. | `selector` (str), `text` (str) |
| `hover_element` | Hovers over an element defined by a CSS selector. | `selector` (str) |
| `select_option` | Selects an option in a `<select>` element by its value. | `selector` (str), `value` (str) |
| `wait_for_element` | Waits for an element to appear in the DOM. Essential for React/SPA apps. | `selector` (str), `timeout` (int, default 15000) |
| `execute_script` | Executes arbitrary JavaScript in the active tab context. Returns the result. | `script` (str) |

## Data Extraction

| Tool Name | Description | Arguments |
| :--- | :--- | :--- |
| `read_page` | Returns the text content of the active tab. | None |
| `read_as_markdown` | Converts the active page's HTML content to Markdown. Optimized for LLMs. | None |
| `get_html` | Returns the outerHTML of an element. Useful for inspecting attributes. | `selector` (str) |
| `get_page_metadata` | Returns metadata for the active page (title, description, image, etc). | None |
| `get_console_logs` | Retrieves captured console logs from the browser extension. | None |

## Storage & Cookies

> **Note**: All tools in this section are controlled by the **Allow Data Access** toggle in the extension dashboard. (Default: **Enabled**)

| Tool Name | Description | Arguments |
| :--- | :--- | :--- |
| `get_local_storage` | Retrieves a value from the page's localStorage. | `key` (str) |
| `set_local_storage` | Sets a value in the page's localStorage. | `key` (str), `value` (str) |
| `clear_local_storage` | Clears all data from the page's localStorage. | None |
| `get_session_storage` | Retrieves a value from the page's sessionStorage. | `key` (str) |
| `get_cookies` | Returns all cookies for the current page (document.cookie). **Cannot read `HttpOnly` cookies.** | None |
| `set_cookie` | Sets a cookie using document.cookie. | `name` (str), `value` (str) |

## Media

| Tool Name | Description | Arguments |
| :--- | :--- | :--- |
| `screenshot` | Takes a screenshot of the active tab. | `save_path` (str, optional) |
| `start_recording` | Starts video recording of the active tab. (Supported: Chrome, Edge, Brave) | None |
| `stop_recording` | Stops the video recording and saves it. (Supported: Chrome, Edge, Brave) | `save_path` (str, optional) |
