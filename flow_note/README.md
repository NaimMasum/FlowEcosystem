# Noteboard — Infinite Whiteboard Note-taking App

An infinite, collaborative, real-time syncing whiteboard app designed for simultaneous PC and mobile/touch workflows. Runs a local Node.js server that broadcasts updates instantly to all connected clients and auto-persists board state to disk.

## Features

- **Infinite Canvas**: Scroll, pan, and zoom without boundaries. A radial drafting grid keeps you oriented.
- **Dynamic Dual UI Layouts**:
  - **Desktop Layout**: Floating sidebar, hover controls, and keyboard shortcuts.
  - **Mobile/Touch Layout**: Large bottom-docked touch buttons, gesture-friendly handles, and multi-touch pinch-to-zoom.
- **Synced Operations**: WebSockets synchronize creations, moves, resizing, deletes, and color shifts. Optimistic local rendering keeps interaction latency at zero.
- **Disk Persistence**: Saves changes automatically with a debounced writer to `data/board.json`.

---

## Setup & Running

Make sure you have [Node.js](https://nodejs.org/) installed.

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Start the Server**:
   ```bash
   npm start
   ```

3. **Open the App**:
   - On the host PC: Open [http://localhost:3939](http://localhost:3939).
   - On your Android phone (must be on the same Wi-Fi network): Enter the local LAN IP address printed by the server in your browser, e.g., `http://192.168.1.15:3939`.

---

## Desktop Controls & Shortcuts

- **Pan**: Click and drag empty space, or hold `Space` and drag, or click-drag using Middle-Click.
- **Zoom**: Scroll your mouse wheel. Zoom coordinates focus dynamically on your mouse cursor.
- **Multi-Select**: Hold `Shift` and drag the selection rectangle over elements.
- **Keyboard Hotkeys**:
  - `V`: Switch to Select/Pan mode
  - `N`: Create Sticky Note
  - `R`: Create Rectangle
  - `O`: Create Ellipse/Circle
  - `L`: Create Line
  - `A`: Create Arrow
  - `I`: Insert Image via Link
  - `Delete` / `Backspace`: Remove selected elements
- **Editing Text**: Double-click any sticky note text area. Click anywhere outside (blur) to save and sync.

---

## Mobile & Touch Controls

- **Pan**: Drag empty space with one or two fingers.
- **Zoom**: Pinch empty space with two fingers. Coordinates center automatically on your fingers' midpoint.
- **Toolbar**: Tap buttons along the bottom screen bar to spawn items.
- **Colors & Deletion**: Tap an element to show the bottom drawer containing a color palette and delete button.
- **Editing Text**: Double-tap a sticky note. Tap outside the note to close the keyboard and save.
