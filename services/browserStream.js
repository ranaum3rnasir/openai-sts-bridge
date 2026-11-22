import WebSocket from "ws";
import fs from "fs";
import dotenv from "dotenv";
import Call from "../models/Call.js";
import { SYSTEM_MESSAGE } from "../lib/prompt.js";
import { summarizer } from "../lib/summery.js";

dotenv.config();

function getOpenAIModel() {
  return process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";
}

const LOG_FILE = "browser-stream.log";
const log = (...args) => {
  const line = `[${new Date().toISOString()}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
  console.log("[BROWSER_STREAM]", new Date().toISOString(), ...args);
};
const err = (...args) => {
  const line = `[ERROR ${new Date().toISOString()}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
  console.error("[BROWSER_STREAM]", new Date().toISOString(), ...args);
};

function ulawToPcm16(uVal) {
  uVal = ~uVal & 0xff;
  let t = ((uVal & 0x0f) << 3) + 0x84;
  t <<= (uVal & 0x70) >> 4;
  return uVal & 0x80 ? 0x84 - t : t - 0x84;
}

function convertUlawBase64ToPcm16Base64(ulawBase64) {
  const buf = Buffer.from(ulawBase64, "base64");
  const pcmBuf = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) {
    const sample = ulawToPcm16(buf[i]);
    pcmBuf.writeInt16LE(sample, i * 2);
  }
  return pcmBuf.toString("base64");
}

export function handleBrowserStream(browserWs, req) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const engine = parsedUrl.searchParams.get("engine") || "openai";
  const voice = parsedUrl.searchParams.get("voice") || (engine === "openai" ? "cedar" : "Rachel");
  const agentId = parsedUrl.searchParams.get("agentId") || process.env.ELEVENLABS_AGENT_ID;

  const sessionSid = `BROWSER_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  log("new-browser-session", { sessionSid, engine, voice });

  const startTime = Date.now();
  let firstAudioLatency = null;
  let bargeInCount = 0;
  const qaPairs = [];

  // Pre-create Call entry in database
  Call.create({
    callSid: sessionSid,
    engine,
    voice,
    direction: "outbound",
    callerPhone: "Browser Mic",
    calledPhone: `AI (${engine.toUpperCase()})`,
    status: "in-progress",
  }).catch((e) => err("call-create-error", e.message));

  if (engine === "elevenlabs") {
    setupElevenLabsBrowserSession({
      browserWs,
      sessionSid,
      voice,
      agentId,
      startTime,
      qaPairs,
      onMetricsUpdate: (latency) => { firstAudioLatency = latency; },
      onBargeIn: () => { bargeInCount++; },
    });
  } else {
    setupOpenAIBrowserSession({
      browserWs,
      sessionSid,
      voice,
      startTime,
      qaPairs,
      onMetricsUpdate: (latency) => { firstAudioLatency = latency; },
      onBargeIn: () => { bargeInCount++; },
    });
  }

  browserWs.on("close", async () => {
    const durationSeconds = Math.round((Date.now() - startTime) / 1000);
    log("browser-session-closed", { sessionSid, durationSeconds, bargeInCount, latency: firstAudioLatency });

    try {
      await Call.update(
        {
          status: "completed",
          durationSeconds,
          bargeInCount,
          timeToFirstAudioMs: firstAudioLatency,
        },
        { where: { callSid: sessionSid } }
      );
      await summarizer(qaPairs, sessionSid, "Browser User");
    } catch (e) {
      err("cleanup-error", e.message);
    }
  });
}

// ─── OpenAI Browser Bridge ───────────────────────────────────────────────────
function setupOpenAIBrowserSession({ browserWs, sessionSid, voice, qaPairs, onMetricsUpdate, onBargeIn }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.startsWith("sk-REPLACE")) {
    browserWs.send(JSON.stringify({
      type: "error",
      message: "OPENAI_API_KEY is not configured in .env or Settings.",
    }));
    return;
  }

  const model = getOpenAIModel();
  log("connecting-to-openai-realtime", { model, sessionSid });

  let openaiWs;
  try {
    openaiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
  } catch (e) {
    browserWs.send(JSON.stringify({ type: "error", message: `OpenAI connection failed: ${e.message}` }));
    return;
  }

  let userSpeechEndedAt = 0;
  let activeAssistantResponse = false;
  let speechResponseTimer = null;
  let inboundMicChunks = 0;

  openaiWs.on("open", () => {
    log("openai-ws-open-for-browser", { sessionSid });

    // GA OpenAI Realtime API session configuration schema
    const sessionConfig = {
      type: "session.update",
      session: {
        type: "realtime",
        output_modalities: ["audio"],
        instructions: SYSTEM_MESSAGE,
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            turn_detection: {
              type: "server_vad",
              threshold: 0.2, // Sensitive threshold so browser/laptop mics trigger effortlessly
              prefix_padding_ms: 300,
              silence_duration_ms: 600,
              create_response: true,
              interrupt_response: true,
            },
            transcription: {
              model: "gpt-4o-transcribe",
            },
          },
          output: {
            format: { type: "audio/pcm", rate: 24000 },
            voice: voice || "cedar",
          },
        },
      },
    };

    log("sending-session-update-to-openai", sessionConfig);
    openaiWs.send(JSON.stringify(sessionConfig));
  });

  openaiWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (
      msg.type !== "response.output_audio.delta" &&
      msg.type !== "response.audio.delta" &&
      msg.type !== "rate_limits.updated"
    ) {
      log("from-openai", msg.type, msg.error?.message || msg.response?.status_details || "");
    }

    if (msg.type === "session.updated") {
      log("openai-session-ready", { sessionSid });
      browserWs.send(JSON.stringify({ type: "session_ready", engine: "openai", sampleRate: 24000 }));
      // Send greeting
      openaiWs.send(JSON.stringify({
        type: "response.create",
        response: {
          output_modalities: ["audio"],
          instructions: 'Say exactly: "Hi there, this is Umer from Servwave. I\'m calling about the HVAC system we serviced at your property. Do you have a quick minute?"',
        },
      }));
      return;
    }

    if (msg.type === "response.created") {
      activeAssistantResponse = true;
      if (speechResponseTimer) {
        clearTimeout(speechResponseTimer);
        speechResponseTimer = null;
      }
      return;
    }

    // Audio stream delta from OpenAI -> forward to browser
    if (msg.type === "response.output_audio.delta" || msg.type === "response.audio.delta") {
      if (userSpeechEndedAt) {
        const latency = Date.now() - userSpeechEndedAt;
        onMetricsUpdate(latency);
        browserWs.send(JSON.stringify({ type: "latency", latencyMs: latency }));
        userSpeechEndedAt = 0;
      }

      const delta = msg.delta;
      if (delta) {
        browserWs.send(JSON.stringify({
          type: "audio",
          audio: delta,
          sampleRate: 24000,
        }));
      }
      return;
    }

    // Caller started speaking -> interruption / barge-in
    if (msg.type === "input_audio_buffer.speech_started") {
      log("speech-started-detected", { sessionSid, activeAssistantResponse });
      if (speechResponseTimer) {
        clearTimeout(speechResponseTimer);
        speechResponseTimer = null;
      }
      if (activeAssistantResponse) {
        onBargeIn();
        openaiWs.send(JSON.stringify({ type: "response.cancel" }));
        browserWs.send(JSON.stringify({ type: "interrupted" }));
        activeAssistantResponse = false;
      }
      return;
    }

    // Caller stopped speaking
    if (msg.type === "input_audio_buffer.speech_stopped") {
      log("speech-stopped-detected", { sessionSid });
      userSpeechEndedAt = Date.now();

      // Watchdog: If server VAD doesn't trigger response.created within 500ms, explicitly trigger response
      if (speechResponseTimer) clearTimeout(speechResponseTimer);
      speechResponseTimer = setTimeout(() => {
        if (!activeAssistantResponse && openaiWs.readyState === WebSocket.OPEN) {
          log("watchdog-triggering-response-create", { sessionSid });
          openaiWs.send(JSON.stringify({
            type: "response.create",
            response: { output_modalities: ["audio"] },
          }));
        }
      }, 500);
      return;
    }

    // Caller transcript
    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const text = msg.transcript?.trim() || "";
      if (text) {
        log("user-transcript", { text });
        browserWs.send(JSON.stringify({ type: "user_transcript", text }));
        qaPairs.push({ q: text, a: "" });
      }
      return;
    }

    // Assistant transcript delta / done
    if (msg.type === "response.output_audio_transcript.done" || msg.type === "response.audio_transcript.done") {
      const text = msg.transcript?.trim() || "";
      if (text) {
        log("assistant-transcript", { text });
        browserWs.send(JSON.stringify({ type: "assistant_transcript", text }));
        if (qaPairs.length > 0 && !qaPairs[qaPairs.length - 1].a) {
          qaPairs[qaPairs.length - 1].a = text;
        } else {
          qaPairs.push({ q: null, a: text });
        }
      }
      return;
    }

    if (msg.type === "response.done") {
      activeAssistantResponse = false;
      if (speechResponseTimer) {
        clearTimeout(speechResponseTimer);
        speechResponseTimer = null;
      }
      const outputs = msg.response?.output || [];
      for (const out of outputs) {
        for (const item of out.content || []) {
          if (item.transcript && (!qaPairs.length || !qaPairs[qaPairs.length - 1].a)) {
            const text = item.transcript.trim();
            browserWs.send(JSON.stringify({ type: "assistant_transcript", text }));
            if (qaPairs.length > 0 && !qaPairs[qaPairs.length - 1].a) {
              qaPairs[qaPairs.length - 1].a = text;
            } else {
              qaPairs.push({ q: null, a: text });
            }
          }
        }
      }
      return;
    }

    if (msg.type === "error" || msg.type === "response.failed") {
      err("OPENAI_ERROR_EVENT", JSON.stringify(msg.error || msg.response?.status_details || msg));
      browserWs.send(JSON.stringify({ type: "error", message: msg.error?.message || "OpenAI error" }));
      return;
    }
  });

  browserWs.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    if (data.type === "audio_chunk" && data.audio) {
      inboundMicChunks++;
      if (inboundMicChunks % 25 === 1) {
        const buf = Buffer.from(data.audio, "base64");
        let sumSq = 0;
        const numSamples = buf.length / 2;
        for (let i = 0; i < buf.length; i += 2) {
          const s = buf.readInt16LE(i);
          sumSq += s * s;
        }
        const rms = Math.round(Math.sqrt(sumSq / Math.max(1, numSamples)));
        log(`inbound-mic-audio [${sessionSid}] chunk #${inboundMicChunks}, samples: ${numSamples}, RMS: ${rms} ${rms > 80 ? "🔊 (voice active)" : "🔈 (quiet/silence)"}`);
      }
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: data.audio,
        }));
      }
    }
  });

  browserWs.on("close", () => {
    if (speechResponseTimer) clearTimeout(speechResponseTimer);
    try {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    } catch {}
  });
}

// ─── ElevenLabs Browser Bridge ───────────────────────────────────────────────
async function setupElevenLabsBrowserSession({ browserWs, sessionSid, voice, agentId, qaPairs, onMetricsUpdate, onBargeIn }) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const currentAgentId = agentId || process.env.ELEVENLABS_AGENT_ID;

  if (!currentAgentId) {
    browserWs.send(JSON.stringify({
      type: "error",
      message: "ELEVENLABS_AGENT_ID is required. Enter it in Settings or the Agent ID field.",
    }));
    return;
  }

  let wsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(currentAgentId)}`;

  // If API key is present, attempt to retrieve authenticated signed URL
  if (apiKey) {
    try {
      const resp = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(currentAgentId)}`,
        { headers: { "xi-api-key": apiKey } }
      );
      if (resp.ok) {
        const d = await resp.json();
        if (d.signed_url) wsUrl = d.signed_url;
      }
    } catch {}
  }

  let elWs;
  try {
    elWs = new WebSocket(wsUrl);
  } catch (e) {
    browserWs.send(JSON.stringify({ type: "error", message: `ElevenLabs connection error: ${e.message}` }));
    return;
  }

  let userSpeechEndedAt = 0;
  let inboundChunks = 0;
  let agentOutputRate = 16000;
  let userInputRate = 16000;

  elWs.on("open", () => {
    log("elevenlabs-ws-open-for-browser", { sessionSid });

    // Send clean initiation without forbidden client overrides
    elWs.send(JSON.stringify({
      type: "conversation_initiation_client_data",
    }));
  });

  elWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "conversation_initiation_metadata") {
      const meta = msg.conversation_initiation_metadata_event;
      log("elevenlabs-metadata-ready", {
        sessionSid,
        agentOutputAudioFormat: meta?.agent_output_audio_format,
        userInputAudioFormat: meta?.user_input_audio_format,
      });

      if (meta?.agent_output_audio_format === "pcm_24000") agentOutputRate = 24000;
      else if (meta?.agent_output_audio_format === "pcm_16000") agentOutputRate = 16000;
      else if (meta?.agent_output_audio_format?.startsWith("pcm_44100")) agentOutputRate = 44100;
      else agentOutputRate = 16000;

      if (meta?.user_input_audio_format === "pcm_24000") userInputRate = 24000;
      else if (meta?.user_input_audio_format === "pcm_16000") userInputRate = 16000;
      else userInputRate = 16000;

      browserWs.send(JSON.stringify({ type: "session_ready", engine: "elevenlabs", sampleRate: userInputRate }));
      return;
    }

    // Audio stream from ElevenLabs (PCM16) -> send directly for browser playback
    if (msg.type === "audio") {
      const audioPayload = msg.audio_event?.audio_base_64;
      if (audioPayload) {
        if (userSpeechEndedAt) {
          const latency = Date.now() - userSpeechEndedAt;
          onMetricsUpdate(latency);
          browserWs.send(JSON.stringify({ type: "latency", latencyMs: latency }));
          userSpeechEndedAt = 0;
        }

        browserWs.send(JSON.stringify({
          type: "audio",
          audio: audioPayload,
          sampleRate: agentOutputRate,
        }));
      }
      return;
    }

    // Interruption
    if (msg.type === "interruption") {
      log("elevenlabs-interrupted", { sessionSid });
      onBargeIn();
      browserWs.send(JSON.stringify({ type: "interrupted" }));
      return;
    }

    // Ping / Pong
    if (msg.type === "ping") {
      elWs.send(JSON.stringify({ type: "pong", event_id: msg.ping_event?.event_id }));
      return;
    }

    // Caller transcript
    if (msg.type === "user_transcript") {
      const text = msg.user_transcription_event?.user_transcript?.trim();
      if (text) {
        log("elevenlabs-user-transcript", { text });
        userSpeechEndedAt = Date.now();
        browserWs.send(JSON.stringify({ type: "user_transcript", text }));
        qaPairs.push({ q: text, a: "" });
      }
      return;
    }

    // Assistant transcript
    if (msg.type === "agent_response") {
      const text = msg.agent_response_event?.agent_response?.trim();
      if (text) {
        log("elevenlabs-assistant-transcript", { text });
        browserWs.send(JSON.stringify({ type: "assistant_transcript", text }));
        if (qaPairs.length > 0 && !qaPairs[qaPairs.length - 1].a) {
          qaPairs[qaPairs.length - 1].a = text;
        } else {
          qaPairs.push({ q: null, a: text });
        }
      }
      return;
    }

    if (msg.type === "error" || msg.type === "internal_error") {
      err("elevenlabs-error", msg.message || JSON.stringify(msg));
      browserWs.send(JSON.stringify({ type: "error", message: msg.message || "ElevenLabs error" }));
      return;
    }
  });

  browserWs.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    if (data.type === "audio_chunk" && data.audio) {
      inboundChunks++;
      if (inboundChunks % 30 === 1) {
        log(`inbound-mic-elevenlabs [${sessionSid}] chunk #${inboundChunks}`);
      }
      if (elWs.readyState === WebSocket.OPEN) {
        elWs.send(JSON.stringify({
          user_audio_chunk: data.audio,
        }));
      }
    }
  });

  browserWs.on("close", () => {
    try {
      if (elWs && elWs.readyState === WebSocket.OPEN) elWs.close();
    } catch {}
  });
}
