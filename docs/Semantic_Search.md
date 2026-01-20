# Semantic Search Architecture

## Overview
Uplink gives AI agents "eyes" and "intuition" by embedding a local neural network directly into the browser. This allows agents to find elements based on **semantics** (what they mean) rather than just syntax (CSS selectors).

Instead of relying on fragile XPaths like `/div[2]/span[4]`, an agent can simply ask for `"the price tag"` or `"the login button"`, and Uplink finds the best match using vector similarity.

## Architecture
Uplink runs **100% locally** within the browser, ensuring user privacy and zero additional API costs.

1.  **Engine**: [Transformers.js](https://huggingface.co/docs/transformers.js) runs standard ONNX models via WebAssembly (WASM).
2.  **Location**: The model resides in the **Extension Service Worker** (`background.js`).
3.  **Process**:
    -   **Distillation**: The content script simplifies the DOM into "Virtual Documents" for each interactive candidate.
    -   **Embedding**: The candidates are sent to the Service Worker, where they are converted into vector embeddings (384-dimension arrays).
    -   **Search**: The user's query is also embedded.
    -   **Ranking**: A Cosine Similarity search finds the element vector closest to the query vector.

## Signal Optimization (The "Virtual Document")
To achieve high reliability, Uplink doesn't just embed the raw text of a button. It constructs a rich **semantic profile** by concatenating multiple signals:

1.  **Visible Text**: The primary label.
2.  **ARIA Labels**: Accessibility descriptions.
3.  **Titles & Tooltips**: Hover-over information.
4.  **Placeholders**: Input hint text.
5.  **Alt Text**: Image descriptions for icon-based buttons.
6.  **Contextual Luck**: For short or empty links, the `href` slug is appended (e.g., `[Donate /wiki/Donate]`).

This multi-signal approach drastically improves confidence scores for "obvious" targets that might otherwise be represented by a generic icon or a short word.

## Configuration
Uplink allows you to swap the AI "brain" based on your needs. Configuration is available via the **Extension Dashboard**.

### Available Models
Models are downloaded from Hugging Face and cached locally in the browser.

| Model | Size | Speed | Use Case |
| :--- | :--- | :--- | :--- |
| **`Xenova/all-MiniLM-L6-v2`** | 80MB | ⭐⭐⭐⭐⭐ | **Default**. Best balance of speed and accuracy. Ideal for general browsing. |
| **`Xenova/bge-small-en-v1.5`** | 130MB | ⭐⭐⭐⭐ | **High Accuracy**. Better at understanding complex queries or nuance. Use if the default misses subtle elements. |
| **`Xenova/paraphrase-MiniLM-L3-v2`** | 45MB | ⭐⭐⭐⭐⭐ | **Ultra-Light**. Use on low-end devices or if RAM is constrained. |

### Cache Management
Each model is stored in the browser's **Cache Storage API** (similar to standard website assets). 
- **Persistance**: Models remain available offline once downloaded.
- **Clearing**: If you encounter corrupted downloads or want to free up space (models can be 100MB+), use the **"Clear Cache"** button in the Dashboard. This will force a re-download next time a model is selected.

### Custom Models & Hubs
You can point Uplink to any Hugging Face model compatible with `feature-extraction` pipelines in Transformers.js. You can also specify a **Custom Hub URL** to load models from a local server or corporate mirror, useful for air-gapped environments.

Usage via Tool:
```javascript
// Switch to a custom model
set_model_config(model_id="my-org/custom-model", custom_hub="https://internal.hub.com/");
```

## Performance & Token Usage
Since the model runs locally, "tokens" refer to computational cost, not financial cost.

-   **Inference Time**: 
    -   **Query**: ~10-50ms
    -   **Page Processing**: ~100-500ms for 100+ candidates on a modern CPU.
-   **Batching**: Uplink uses concurrent processing (`Promise.all`) to embed page elements in parallel, maximizing WASM throughput.
-   **Startup**: The first search triggers a model load (cold start), which may take 1-2 seconds (or longer if downloading). Subsequent searches are cached and hot.

## Privacy
-   **Zero Data Leakage**: No page content or queries are ever sent to a cloud server.
-   **Local Execution**: Everything happens on `localhost` within the extension sandbox.

## Troubleshooting
- **Low Confidence Scores (< 0.3)**: Usually means the query is too ambiguous or the element lacks text/attributes. Try being more descriptive (e.g., "The blue login button" instead of just "Login").
- **Extension "Suspended"**: In Firefox, the extension may sleep to save resources. Clicking the "Suspended" status button in the Dashboard will wake it up and attempt a manual reconnection.
