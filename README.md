# Stage Mesh (LAN Crew Messaging)

Stage Mesh is a local-network point-to-point messaging app.

## Features in this baseline

- Multi-device messaging over the same LAN
- Direct one-to-one messaging between devices
- Priority message levels (normal, high, critical)
- Delivery acknowledgment tracking (per-message delivered count)
- Offline outbox queue with automatic resend on reconnect
- Presence list of online devices
- Conversation history for the selected recipient
- Speech-to-text modes:
  - Hold-to-speak dictation
  - Always-listening mode with visible state

## Run

1. Install dependencies:

   npm install

2. Start the server:

   npm start

3. Open on host machine:

   http://localhost:8080

4. Open on other devices in same network:

   http://<host-lan-ip>:8080

The app now auto-joins each device immediately with no login prompt.

## Browser speech support

Speech-to-text relies on browser speech recognition support (commonly available in Chromium-based browsers). The UI falls back to typing when not supported.

## Current protocol events

Client to server:
- join
- get_history
- send_message
- ack

Server to client:
- server_hello
- joined
- history
- message
- message_accepted
- message_delivery
- alert
- presence
- error
