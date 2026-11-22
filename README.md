# 🎙️ Voice AI Bridge: OpenAI Realtime vs. ElevenLabs STS

A dual-engine real-time Speech-to-Speech (STS) voice bridge connecting **Twilio Telephony** with:
1. **OpenAI Realtime API** (`gpt-realtime`)
2. **ElevenLabs Conversational AI** (`ConvAI`)

Includes a **demo web dashboard** for launching outbound comparison calls, listening to dual-track Twilio recordings, reviewing transcripts, and benchmarking latency, voice naturalness, and barge-in performance side-by-side.

---

## 🏗️ Architecture

```
                                    ┌─── (engine=openai) ──────► OpenAI Realtime API (WS)
Phone Call ──► Twilio ──► Node.js ──┤
               (µ-law)   Server     └─── (engine=elevenlabs) ──► ElevenLabs Conversational AI (WS)
                            ▲
                            │
                     Web Dashboard UI (localhost:3000)
                     [Outbound dialer, live monitor, comparative analytics]
```

### 1. OpenAI Realtime (`New.js`)
- Protocol: `wss://api.openai.com/v1/realtime?model=gpt-realtime`
- Format: Native µ-law (`audio/pcmu`), 8 kHz
- Turn Detection: Server VAD + client-side adaptive dBFS energy tracker for responsive barge-in.
- Voices: `cedar`, `alloy`, `echo`, `shimmer`, `marin`.

### 2. ElevenLabs Conversational AI (`services/elevenlabsStream.js`)
- Protocol: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=<AGENT_ID>`
- Format: Native µ-law 8 kHz (`user_audio_chunk` and `audio_event`)
- Turn Detection: Native ElevenLabs server-side interruption events (`type: "interruption"` triggers Twilio `clear` buffer).
- Features: Realistic conversational cadence, emotional inflection, breaths, and custom cloned voices.

---

## 🚀 Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Update with your credentials:
```env
# OpenAI
OPENAI_API_KEY=sk-...
OPENAI_REALTIME_MODEL=gpt-realtime
REALTIME_VOICE=cedar

# ElevenLabs
ELEVENLABS_API_KEY=xi-...
ELEVENLABS_AGENT_ID=agent_...    # From ElevenLabs Console > Conversational AI

# Twilio
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+18005559999

# Server & Ngrok
PORT=3000
PUBLIC_BASE_URL=https://your-ngrok-url.ngrok-free.app
```

> **Note:** Credentials can also be configured or updated directly in the Demo UI by clicking **⚙️ Settings & Keys**.

### 3. Seed Database with Dummy Comparison Data
```bash
npm run seed
```
This populates SQLite (`database.sqlite`) with test customers and sample calls comparing OpenAI vs ElevenLabs.

### 4. Start Local Public Tunnel (e.g. Ngrok)
```bash
ngrok http 3000
```
Copy the forwarding HTTPS URL and set it as `PUBLIC_BASE_URL` in `.env` or in the UI settings.

### 5. Start the Server
```bash
npm start
# or auto-reloading dev mode:
npm run dev
```
Open **`http://localhost:3000`** in your browser.

---

## 🧪 Testing & Comparing the Engines

### Option A: Outbound Call from the Demo UI (Recommended)
1. Open `http://localhost:3000`.
2. Under **"Launch a Comparison Call"**, select:
   - ⚡ **OpenAI Realtime** or 💎 **ElevenLabs Conversational AI**
3. Select your desired voice.
4. Enter your destination mobile number.
5. Click **"Dial Phone & Compare"**.
6. Answer your phone and converse with the AI! Test:
   - Voice naturalness & tone
   - Interruption / barge-in (speak while the AI is talking)
   - Latency (time to response after you finish speaking)

### Option B: Inbound Call via Twilio Number
In your [Twilio Console](https://console.twilio.com) under your active phone number's Voice configuration:
- For **OpenAI**: Set Webhook (POST) to:
  ```
  https://your-ngrok-url/incoming-call?engine=openai
  ```
- For **ElevenLabs**: Set Webhook (POST) to:
  ```
  https://your-ngrok-url/incoming-call?engine=elevenlabs
  ```

---

## 📊 Comparison Matrix

| Benchmark Dimension | OpenAI Realtime (`gpt-realtime`) | ElevenLabs Conversational AI |
|---|---|---|
| **Turnaround Latency** | ~600–900 ms (Fast end-to-end token generation) | ~750–1100 ms (High-fidelity neural rendering) |
| **Voice Naturalness** | Good, smooth conversational flow | **Superior**, human-like intonation, breaths, and warmth |
| **Barge-in / Interruptions** | Server VAD + client dBFS cancellation | Server-side interruption events with audio clear |
| **Voice Flexibility** | Fixed set of 9 built-in voices | 1,000+ voices, voice cloning, emotional styles |
| **Telephony Codec** | Native µ-law 8kHz | Native µ-law 8kHz |
| **Setup Simplicity** | Direct API key & model parameter | Requires an Agent ID configured in ElevenLabs console |

---

## 📁 Key File Map

- `server.js` — Express & unified WebSocket dispatcher routing between OpenAI & ElevenLabs.
- `New.js` — OpenAI Realtime WebSocket bridge & telephony audio processor.
- `services/elevenlabsStream.js` — ElevenLabs Conversational AI WebSocket bridge for Twilio media streams.
- `routes/callRoutes.js` — Outbound call initiator, call history, feedback ratings, and comparison stats API.
- `models/Call.js` & `models/user.js` — Sequelize ORM schemas storing call transcripts, durations, latency, ratings, and engine metadata.
- `public/` — Demo frontend dashboard (`index.html`, `styles.css`, `app.js`).
