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

## Optional SSL (HTTPS)

You can run the server with TLS certificates so the app serves over HTTPS.

1. Set environment variables to your certificate files:

   - SSL_KEY_PATH
   - SSL_CERT_PATH
   - SSL_CA_PATH (optional)

2. Start the app as normal:

   npm start

   or use the HTTPS helper command (defaults to local cert files):

   npm run start:https

   Default certificate paths used by `start:https`:

   - certs/localhost-key.pem
   - certs/localhost-cert.pem

If certificates are valid, the app runs on https://localhost:3000 (or your chosen PORT).
If certs are missing or invalid, the app automatically falls back to HTTP.

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

## macOS DMG signing and notarization

The GitHub release workflow can build and upload a macOS DMG.
To prevent the "app is damaged" Gatekeeper warning, configure these repository secrets:

- MACOS_CERT_P12_BASE64
- MACOS_CERT_PASSWORD
- APPLE_ID
- APPLE_APP_SPECIFIC_PASSWORD
- APPLE_TEAM_ID

Notes:

- `MACOS_CERT_P12_BASE64` should be your Developer ID Application `.p12` content encoded in base64.
- `APPLE_APP_SPECIFIC_PASSWORD` is generated from your Apple ID account security settings.
- The macOS release job now fails fast when these secrets are missing.

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
