# Звонок Шерифу (Sheriff video call)

Node server (express) serves `public/` and mints short-lived xAI realtime client secrets at `POST /api/session`.
The browser connects directly to `wss://api.x.ai/v1/realtime` (grok-voice-latest, server VAD, 24 kHz PCM) with the
`xai-client-secret.<token>` subprotocol; the long-lived key never leaves the server.

Run:
    npm install
    XAI_API_KEY=xai-... node server.js        # or LLM_API_KEY; PORT=8787 by default; SHERIFF_VOICE=rex
    cloudflared tunnel --url http://localhost:8787   # gives https://….trycloudflare.com for phones

URL options (tune without redeploying):
- ?cc subtitles, ?voice=leo other voice, ?debug event log + mic level/gate state
- ?name=Варвара child's name hint (ASR keyterm + prompt hint)
- ?vad=0.35 server VAD threshold (lower = more sensitive), ?silence=1000 ms of silence that ends her turn, ?prefix=500 ms padding kept before speech start
- ?barge=0.06 mic RMS needed to interrupt while Sheriff talks, ?hang=900 ms gate stays open after that, ?preroll=400 ms of audio kept before the gate opens
- ?ns=1 enable browser noise suppression (off by default, it eats child voices), ?agc=0 disable auto gain
Server defaults via env: VAD_THRESHOLD, VAD_SILENCE_MS, VAD_PREFIX_MS, SHERIFF_VOICE.
Persona prompt: persona.md. Calls auto-end after 20 min; token minting capped at 60/hour.
