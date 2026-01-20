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

> [!NOTE]
> All interaction tools are instrumented to return execution duration (e.g., `"Clicked (Internal: 45ms)"`) to help diagnose UI freezes.

| Tool Name | Description | Arguments |
| :--- | :--- | :--- |
| `click_element` | Clicks an element. Supports Numeric IDs (e.g., "1") from `read_page` or CSS selectors. | `selector` (str), `purpose` (str, optional) |
| `type_text` | Types text into an element. Supports Numeric IDs or CSS selectors. | `selector` (str), `text` (str) |
| `press_key` | Presses a key on the page or specific element. | `key` (str), `selector` (str, optional) |
| `hover_element` | Hovers over an element. Supports Numeric IDs or CSS selectors. | `selector` (str) |
| `select_option` | Selects an option in a `<select>` element. Supports Numeric IDs or CSS selectors. | `selector` (str), `value` (str) |
| `wait_for_element` | Waits for an element to appear (Numeric ID or CSS selector). Essential for React/SPA apps. Returns wait duration. | `selector` (str), `timeout` (int, default 15000) |
| `execute_script` | Executes arbitrary JavaScript in the active tab context. Returns the result. | `script` (str) |

## Data Extraction

| Tool Name | Description | Arguments |
| :--- | :--- | :--- |
| `read_page` | Returns the page content. Default format is 'distilled' (ID-mapped), which is **anti-scraping resilient** (respects `inert`, `aria-hidden`). | `format` (str, optional: 'distilled' (default), 'text', 'html') |
| `read_as_markdown` | Converts the active page's HTML content to Markdown. Optimized for LLMs and RAG. | None |
| `get_html` | Returns the outerHTML of an element. Useful for inspecting attributes. | `selector` (str) |
| `get_page_metadata` | Returns metadata for the active page (title, description, image, etc). | None |

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

## AI & Semantic Features

| Tool Name | Description | Arguments |
| :--- | :--- | :--- |
| `semantic_find` | Finds elements using natural language search. Powered by **Virtual Document** signal enrichment (combines text, aria, title, href). | `query` (str) |
| `set_model_config` | Configures the AI model used for semantic search. Supports presets or custom Hugging Face model IDs. | `model_id` (str, optional), `custom_hub` (str, optional) |
| `clear_model_cache` | Clears the local browser cache of downloaded AI models. Useful for low disk space or corrupted downloads. | None |
| `get_extension_status` | Returns the current status of the extension, including AI model state, active errors, and debug logs. | None |

## Performance & Observability

| Tool Name | Description | Arguments |
| :--- | :--- | :--- |
| `check_errors` | Analyzes browser console errors and network failures. Returns a **semantically clustered** summary of issues. | None |
| `manage_session` | Clears browser session state (cookies, local storage) and captured logs. | `action` (str, optional: 'clear' (default), 'clear_logs') |
| `get_page_performance` | Returns a holistic performance report: TTFB, FCP, Page Load, and **Interaction Timings**. | None |
| `audit_accessibility` | Checks the page for accessibility violations using **axe-core**. Returns a summarized report mapped to Numeric IDs. | None |
| `get_console_logs` | Retrieves raw captured console logs from the browser extension. Moved here from Data Extraction. | None |

