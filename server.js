/**
 * server.js — Entry point for Get Pie Pay AI Voice Bridge
 * Supporting side-by-side comparison between:
 *  1. OpenAI Realtime API (Speech-to-Speech)
 *  2. ElevenLabs Conversational AI (Speech-to-Speech)
 */

import dotenv from "dotenv";
dotenv.config();

import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import { WebSocketServer } from "ws";
import { syncDatabase } from "./models/index.js";
import { handleOpenAIMediaStream } from "./New.js";
import { handleElevenLabsMediaStream } from "./services/elevenlabsStream.js";
import { handleBrowserStream } from "./services/browserStream.js";
import callRoutes from "./routes/callRoutes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─── Serve Demo Frontend ───────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public"), {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  },
}));

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use("/api", callRoutes);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    engines: ["openai", "elevenlabs"],
    timestamp: new Date().toISOString(),
  });
});

// ─── Twilio Incoming Call Webhook ─────────────────────────────────────────────
// Supports ?engine=openai or ?engine=elevenlabs & optional ?voice=...
app.all("/incoming-call", (req, res) => {
  let streamHost = req.headers["x-forwarded-host"] || req.headers.host;
  let protocol = "wss";

  // Prefer RENDER_EXTERNAL_URL if on Render, otherwise use PUBLIC_BASE_URL
  let publicBase = process.env.RENDER_EXTERNAL_URL;
  if (!publicBase || publicBase.includes("localhost")) {
    publicBase = process.env.PUBLIC_BASE_URL;
  }
  if (publicBase) {
    try {
      const parsedBase = new URL(publicBase);
      streamHost = parsedBase.host;
      protocol = parsedBase.protocol === "http:" ? "ws" : "wss";
    } catch (e) {
      console.warn("[TWILIO_WEBHOOK] Failed to parse public URL:", e.message);
    }
  }

  const engine = req.query.engine || req.body.engine || process.env.DEFAULT_ENGINE || "openai";
  const voice = req.query.voice || req.body.voice || "";
  const agentId = req.query.agentId || req.body.agentId || "";

  const params = new URLSearchParams();
  params.set("engine", engine);
  if (voice) params.set("voice", voice);
  if (agentId) params.set("agentId", agentId);

  // In XML attributes, & MUST be escaped as &amp; otherwise Twilio throws Error 12100 (Document parse failure)
  const rawStreamUrl = `${protocol}://${streamHost}/media-stream/${engine}?${params.toString()}`;
  const xmlStreamUrl = rawStreamUrl.replace(/&/g, "&amp;");

  const from = req.body.From || req.query.From || "";
  const to = req.body.To || req.query.To || "";

  console.log(`[TWILIO_WEBHOOK] Incoming call routing to Engine: [${engine.toUpperCase()}] streamUrl: ${rawStreamUrl}`);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${xmlStreamUrl}">
      <Parameter name="engine" value="${engine}" />
      <Parameter name="voice" value="${voice}" />
      <Parameter name="agentId" value="${agentId}" />
      <Parameter name="from" value="${from}" />
      <Parameter name="to" value="${to}" />
    </Stream>
  </Connect>
  <Pause length="40"/>
</Response>`;

  res.set("Content-Type", "text/xml");
  res.send(twiml);
});

// ─── Recording Status Webhook ─────────────────────────────────────────────────
app.post("/recording-status", async (req, res) => {
  const { CallSid, RecordingSid, RecordingUrl, RecordingStatus } = req.body;
  console.log("[RECORDING_STATUS]", { CallSid, RecordingSid, RecordingStatus });

  if (CallSid && RecordingUrl) {
    try {
      const Call = (await import("./models/Call.js")).default;
      await Call.update(
        { recordingSid: RecordingSid, recordingUrl: RecordingUrl },
        { where: { callSid: CallSid } }
      );
    } catch (e) {
      console.error("[RECORDING_SAVE_ERROR]", e.message);
    }
  }

  res.sendStatus(200);
});

// ─── Call Status Webhook (Twilio lifecycle tracking) ──────────────────────────
app.post("/call-status", async (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body;
  console.log("[CALL_STATUS_EVENT]", { CallSid, CallStatus, CallDuration });

  if (CallSid) {
    try {
      const Call = (await import("./models/Call.js")).default;
      const updates = { status: CallStatus };
      if (CallDuration) updates.durationSeconds = parseInt(CallDuration, 10);
      await Call.update(updates, { where: { callSid: CallSid } });
    } catch (e) {
      console.error("[CALL_STATUS_UPDATE_ERROR]", e.message);
    }
  }

  res.sendStatus(200);
});

// ─── HTTP Server & WebSocket Upgrade ──────────────────────────────────────────
const server = http.createServer(app);

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});

server.on("upgrade", (req, socket, head) => {
  const pathname = req.url.split("?")[0];
  console.log(`[WS_UPGRADE] Incoming upgrade request: ${pathname}`);

  if (
    pathname === "/media-stream" ||
    pathname === "/media-stream/openai" ||
    pathname === "/media-stream/elevenlabs" ||
    pathname === "/browser-stream"
  ) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ─── WebSocket Connection Dispatcher ──────────────────────────────────────────
wss.on("connection", (ws, req) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname;

  // 1. Direct Browser Microphone / Speaker Session
  if (pathname === "/browser-stream") {
    handleBrowserStream(ws, req);
    return;
  }

  // 2. Twilio Telephony Media Stream
  let engine = parsedUrl.searchParams.get("engine");

  if (!engine) {
    if (parsedUrl.pathname.includes("elevenlabs")) {
      engine = "elevenlabs";
    } else {
      engine = "openai";
    }
  }

  const voice = parsedUrl.searchParams.get("voice") || "";
  const agentId = parsedUrl.searchParams.get("agentId") || "";

  console.log(
    `[WS_DISPATCHER] New Media Stream connection -> Routing to Engine: [${engine.toUpperCase()}]`
  );

  if (engine.toLowerCase() === "elevenlabs") {
    handleElevenLabsMediaStream(ws, req, { voice, agentId });
  } else {
    handleOpenAIMediaStream(ws, req, { voice });
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function start() {
  try {
    await syncDatabase();
    console.log("[DB] Database synchronized (database.sqlite)");
  } catch (err) {
    console.error("[DB] Database sync error:", err.message);
  }

  server.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🎙️  AI Voice Bridge: OpenAI & ElevenLabs STS Comparison`);
    console.log(`======================================================`);
    console.log(`🌐 Demo Frontend:   http://localhost:${PORT}`);
    console.log(`🩺 Health API:      http://localhost:${PORT}/health`);
    console.log(`📞 Inbound Webhook: POST http://localhost:${PORT}/incoming-call`);
    console.log(`   └─ OpenAI:       POST http://localhost:${PORT}/incoming-call?engine=openai`);
    console.log(`   └─ ElevenLabs:   POST http://localhost:${PORT}/incoming-call?engine=elevenlabs`);
    console.log(`======================================================\n`);
  });
}

start();
