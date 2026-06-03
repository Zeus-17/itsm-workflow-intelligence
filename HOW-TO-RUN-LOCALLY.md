# Using the ITSM Workflow Intelligence Tool Locally

The tool is fully self-contained in a single HTML file. However, browsers apply security restrictions when opening HTML files directly from your desktop (`file://` protocol), which can prevent features like session save/restore, export and the accessibility panel from working correctly.

**There are three ways to use the tool — choose the one that suits you.**

---

## Option 1 — Use it online (recommended for most people)

Visit the tool directly in your browser. No installation needed. Your data never leaves your machine.

**[https://zeus-17.github.io/itsm-workflow-intelligence/](https://zeus-17.github.io/itsm-workflow-intelligence/)**

Works in Chrome, Edge, Firefox and Safari. Everything functions correctly over HTTPS.

---

## Option 2 — Install it as a desktop app (recommended for offline use)

The tool is a Progressive Web App (PWA). After visiting the URL above once, you can install it as a desktop application that works fully offline — no browser window, no internet connection required.

**In Chrome or Edge:**
1. Visit the URL above
2. Look for the install icon (⊞) in the address bar — right side
3. Click it and select **Install**
4. The tool installs and opens as a standalone app
5. Find it in your Start Menu / Applications as **ITSM Tool**

**On mobile (iOS/Android):**
1. Visit the URL in Safari (iOS) or Chrome (Android)
2. Tap the Share button → **Add to Home Screen**
3. The tool installs as an app icon on your home screen

Once installed, the tool works completely offline. Open it from your taskbar or Start Menu like any other application.

---

## Option 3 — Run it locally with a simple web server

If you want to use the downloaded HTML file without an internet connection and without installing it as a PWA, you can run a local web server in about 30 seconds. This bypasses all browser security restrictions.

**Python (installed on most Macs and many Windows machines):**

```bash
# Navigate to the folder containing the HTML file
cd "C:\Users\YourName\Downloads\itsm-tool"

# Start the server
python -m http.server 8080
```

Then open your browser and go to:
```
http://localhost:8080/itsm-workflow-tool-v25.html
```

**Node.js (if you have Node installed):**

```bash
cd "C:\Users\YourName\Downloads\itsm-tool"
npx serve .
```

Then open the URL shown in the terminal (usually `http://localhost:3000`).

Stop the server when you are done: press `Ctrl+C` in the terminal.

---

## Files in this repository

| File | Purpose |
|---|---|
| `index.html` | The tool itself |
| `manifest.json` | PWA configuration — enables the Install button |
| `sw.js` | Service worker — enables offline use after first visit |
| `itsm-showcase.html` | 14-slide interactive showcase |
| `itsm-demo-v25.html` | Self-running 83-second demo |
| `HOW-TO-RUN-LOCALLY.md` | This file |
| `README.md` | Full feature documentation |

---

## Why does this limitation exist?

Browsers treat files opened from disk (`file://`) as untrusted by default and block access to storage APIs, download features and some JavaScript capabilities. This is a security feature, not a bug. The same file works correctly when served over HTTP or HTTPS — which is what all three options above provide.

