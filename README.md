# Flow Ecosystem 🌊

Flow Ecosystem is a synchronized, multi-device, real-time collaboration suite. It consists of a real-time infinite whiteboard, an integrated PDF annotation engine, and a natively compiled Android application that dynamically tracks and connects to the Whiteboard across local networks.

## Architecture

The ecosystem is divided into three core micro-services:

### 1. Flow Note (`/flow_note`)
The heart of the ecosystem. A real-time, infinite canvas whiteboard built on WebSockets.
* **Features:** Infinite panning, SVGs shapes, sticky notes, real-time synchronization.
* **Network Magic:** Runs an active mDNS (Bonjour) beacon that broadcasts its presence to the local Wi-Fi subnet, completely eliminating the need for manual IP configuration.
* **Tech Stack:** Node.js, Express, `ws` (WebSockets), Vanilla JS Canvas.

### 2. Flow PDF (`/flow_pdf`)
A heavily modified implementation of Mozilla's PDF.js to support seamless whiteboard integration.
* **Features:** Transparent UI, custom drawing/highlighting capabilities.
* **Bypass Mechanics:** Content-Security-Policy (CSP) and strict origin checks have been manually stripped to allow real-time cross-origin communication with the Flow Note backend.
* **Auto-Sync Engine:** Intercepts PDF.js blob generations and automatically pushes physical `PUT` requests back to the Flow Note server in the background.

### 3. Flow Android (`/flow_android`)
A native Android Java wrapper designed for aggressive local network discovery.
* **Features:** Sweeps the local Wi-Fi subnet with a 40-thread threadpool to dynamically hunt down the Flow Note server on Port 3939.
* **Tech Stack:** Pure Android Java, Gradle 8.5.

## Getting Started

To spin up the ecosystem locally:

### Start the Whiteboard
```bash
cd flow_note
npm install
npm start
```
*The whiteboard will run on `http://localhost:3939` and begin transmitting its IP via mDNS.*

### Start the PDF Engine
```bash
cd flow_pdf
npm install
npm start
```
*The PDF server runs on `http://localhost:4040`.*

### Compile the Android App
Ensure the Android SDK is installed, then:
```bash
cd flow_android
./gradlew assembleDebug
```
*Install the resulting `.apk` via ADB to your device.*

---
*Built autonomously by Antigravity.*
