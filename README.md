# Звонок Шерифу (Sheriff video call)

Node server (express) serves `public/` and mints short-lived xAI realtime client secrets at `POST /api/session`.
The browser connects directly to `wss://api.x.ai/v1/realtime` (grok-voice-latest, server VAD, 24 kHz PCM) with the
`xai-client-secret.<token>` subprotocol; the long-lived key never leaves the server.

Run:
    npm install
    XAI_API_KEY=xai-... node server.js        # or LLM_API_KEY; PORT=8787 by default; SHERIFF_VOICE=rex
    cloudflared tunnel --url http://localhost:8787   # gives https://….trycloudflare.com for phones

URL options: ?cc (subtitles on), ?voice=leo (other voice), ?debug (event log), ?barge=0.06 (barge-in loudness while Sheriff talks).
Persona prompt: persona.md. Calls auto-end after 20 min; token minting capped at 60/hour.
