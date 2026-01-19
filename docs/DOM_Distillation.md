# Intelligent DOM Distillation

## The Problem: The "Raw HTML" Bottleneck

When building AI agents that interact with the web, giving them raw access to the DOM presents three critical challenges:

1.  **Token Overload**: A modern single-page application (SPA) can easily have 50,000+ lines of HTML. Feeding `document.body.outerHTML` to an LLM eats up context windows instantly and costs a fortune.
2.  **Selector Hallucination**: Asking an AI to "click the search button" often results in it guessing a selector like `button#search`, which might not exist or might fail if the site uses dynamic classes (e.g., styled-components like `btn-xj92`).
3.  **Noise Ratio**: Valid HTML text often includes thousands of non-interactive elements (`<div>`, `<span>`, `<script>`, `<style>`) that distract from the actionable UI.

## The Solution: Semantic DOM Mapping

**DOM Distillation** is a process that translates the messy, verbose DOM into a clean, interaction-ready map. Instead of seeing code, the AI sees a structured list of "Interactables."

### Key Features (v2 Parser)

1.  **Numeric IDs (The "Magic Link")**:
    *   Every interactive element is assigned a temporary, unique numeric ID (e.g., `[42]`).
    *   The AI simply says `click_element(42)`.
    *   **Why?** It eliminates selector hallucination. The ID is shorter than a CSS selector and is guaranteed to reference the exact element in memory.

2.  **Smarter Labeling**:
    *   A button with an icon often has empty text (`<button><img src="..."/></button>`).
    *   The distiller hunts for context: `aria-label`, `title`, `alt` text of internal images, placeholders, or even truncated `href`s.
    *   **Result**: Instead of `[15] <button> ""`, the AI sees `[15] <button> "[IMG: Search icon]"`.

3.  **Attribute Extraction ("Bot Gold")**:
    *   Developers often leave "gold" for testing: `data-testid`, `data-cy`.
    *   The distiller extracts these and presents them alongside the element.
    *   It also exposes state: `type="checkbox"`, `checked`, `value`.
    *   **Result**: `[12] <input> "Username" (data-testid="login-user" type="text")`.

4.  **Shadow DOM Piercing**:
    *   Standard `querySelector` cannot see inside Web Components (Shadow DOM).
    *   The distiller recursively walks Shadow Roots, exposing elements that would otherwise be invisible to the agent.

## Architecture: Why Client-Side Processing?

Crucially, all DOM distillation logic executes **locally within the Browser Extension** (`content.js`), not on the server or the LLM.

### Key Advantages
1.  **Direct DOM Access**: The parser uses the browser's native API to query computed styles (visibility), shadow roots, and event listeners. This "live" access is impossible with serialized HTML strings.
2.  **Bandwidth Efficiency**: Instead of sending 5MB of raw HTML to the Python server, the extension processes it instantly and sends only a few KB of distilled text.
3.  **Privacy & Security**: Processing happens on the user's machine. We filter out noise and irrelevant data *before* it leaves the browser tab.
4.  **Distributed Compute**: The heavy lifting of tree traversal is done by the user's browser (which is optimized for it), leaving the Python server free to handle tool execution.

## Implementation Details

### The Parser (`content.js`)
The `getPageSnapshot()` function acts as a semantic "TreeWalker":

1.  **Visibility Check**: It ignores elements that are `display: none`, `visibility: hidden`, or have 0 dimensions.
2.  **Interactivity Heuristics**: It identifies elements as "interactive" if they are:
    *   Standard tags: `a`, `button`, `input`, `select`, `textarea`.
    *   Semantically explicit: `role="button"`.
    *   Event-bound: `onclick` handlers (best effort).
3.  **Mapping State**:
    *   A global `Map<number, HTMLElement>` stores references to every identified element.
    *   This map allows O(1) retrieval when the AI sends an action like `click(42)`.

### Example Output

**Raw HTML (Input):**
```html
<div class="header-v2">
  <a href="/home" aria-label="Go to Dashboard">
    <img src="logo.png" alt="App Logo" />
  </a>
  <input type="text" placeholder="Search..." data-testid="global-search" />
</div>
```

**Distilled Output (What the AI Sees):**
```text
[1] <a> "Go to Dashboard"
[2] <input> "Search..." (type="text" test-id="global-search")
```

## How to Use It

The distillation happens automatically when calling `read_page()`.

1.  **Read**: Agent calls `read_page()`.
2.  **Parse**: Extension scans DOM, assigns IDs, returns the map.
3.  **Act**: Agent calls `click_element("2")` or `type_text("2", "query")`.
4.  **Resolve**: Extension looks up ID `2` in its map and triggers the native event.

## Best Practices: IDs vs Selectors

### When to use Numeric IDs (Recommended)
*   **Context**: Live interactive sessions.
*   **Why**: IDs are ephemeral but perfect for the "here and now." They are 100% accurate and use zero tokens to generate.
*   **Example**: `click_element("12")`

### When to use CSS Selectors
*   **Context**: Writing persistent automation scripts or tests.
*   **Why**: If you need to write a script that runs *tomorrow*, numeric IDs won't work (they change on reload). You need stable selectors.
*   **How**: Use the **Attribute Extraction** data from the distilled output to craft stable selectors.
*   **Example**:
    *   Distilled: `[12] <input> "Username" (test-id="login-user")`
    *   Crafted Selector: `input[data-testid="login-user"]`
