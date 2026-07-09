# LAN Device Finder

LAN Device Finder is a web app that scans your local network and lists discovered devices.

## Features

- Detects active IPv4 interfaces on the host machine
- Scans hosts on a selected interface subnet (or custom CIDR)
- Uses ping sweep plus ARP table lookup for device discovery
- Displays discovered IP address, MAC address, hostname, and source
- Responsive frontend built with HTML, CSS, and JavaScript

## Requirements

- Node.js 18+
- Local network access permissions for ping and arp commands

## Run

1. Install dependencies:

   npm install

2. Start the browser app:

   npm start

3. Open in a browser:

   http://localhost:3000

## Desktop app

Launch the Electron desktop version with:

  npm run electron

This opens the same app in a standalone window and starts the local server automatically.

The desktop build also includes GitHub-based update checks. Use the app menu or tray menu to select "Check for Updates" in a packaged build.

## Build a Windows .exe

Create a portable Windows executable with:

   npm run build:win

The output is written to the dist folder.

Create a Windows installer with:

   npm run build:installer

The installer is also written to the dist folder.

## API endpoints

- GET /api/health
- GET /api/interfaces
- POST /api/scan

POST /api/scan accepts:

- interfaceId (string, optional)
- cidr (string, optional, for example 192.168.1.0/24)
- timeoutMs (number, optional)
- concurrency (number, optional)

Notes:

- CIDR scans support prefixes from /1 through /30.
- Requests are always accepted for valid CIDR ranges; large ranges are truncated.
- Maximum hosts scanned per request is capped to 1024.
