import express from "express";
import twilio from "twilio";
import dotenv from "dotenv";
import Call from "../models/Call.js";
import User from "../models/user.js";

dotenv.config();

const router = express.Router();

function getTwilioClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  return twilio(sid, token);
}

// ─── GET /api/config ─────────────────────────────────────────────────────────
// Returns system status & configuration flags for the UI
router.get("/config", async (req, res) => {
  const twilioClient = getTwilioClient();
  const hasTwilio = Boolean(twilioClient);
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
  const hasElevenLabs = Boolean(process.env.ELEVENLABS_API_KEY);

  let twilioNumbers = [];
  if (twilioClient) {
    try {
      const numbers = await twilioClient.incomingPhoneNumbers.list({ limit: 5 });
      twilioNumbers = numbers.map((n) => ({
        phoneNumber: n.phoneNumber,
        friendlyName: n.friendlyName,
        sid: n.sid,
      }));
    } catch (e) {
      // ignore credential verification errors in config query
    }
  }

  res.json({
    hasTwilio,
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID
      ? `${process.env.TWILIO_ACCOUNT_SID.slice(0, 6)}...`
      : null,
    twilioPhone:
      process.env.TWILIO_PHONE_NUMBER ||
      (twilioNumbers[0] ? twilioNumbers[0].phoneNumber : null),
    twilioNumbers,
    hasOpenAI,
    openAiModel: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
    openAiVoice: process.env.REALTIME_VOICE || "cedar",
    hasElevenLabs,
    elevenLabsAgentId: process.env.ELEVENLABS_AGENT_ID || null,
    publicBaseUrl: process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || null,
  });
});

// ─── POST /api/config ────────────────────────────────────────────────────────
// Updates runtime config from UI (allows adding keys without manual file edits)
router.post("/config", (req, res) => {
  const {
    twilioAccountSid,
    twilioAuthToken,
    twilioPhoneNumber,
    openAiApiKey,
    openAiModel,
    openAiVoice,
    elevenLabsApiKey,
    elevenLabsAgentId,
    publicBaseUrl,
  } = req.body;

  if (twilioAccountSid) process.env.TWILIO_ACCOUNT_SID = twilioAccountSid;
  if (twilioAuthToken) process.env.TWILIO_AUTH_TOKEN = twilioAuthToken;
  if (twilioPhoneNumber) process.env.TWILIO_PHONE_NUMBER = twilioPhoneNumber;
  if (openAiApiKey) process.env.OPENAI_API_KEY = openAiApiKey;
  if (openAiModel) process.env.OPENAI_REALTIME_MODEL = openAiModel;
  if (openAiVoice) process.env.REALTIME_VOICE = openAiVoice;
  if (elevenLabsApiKey) process.env.ELEVENLABS_API_KEY = elevenLabsApiKey;
  if (elevenLabsAgentId) process.env.ELEVENLABS_AGENT_ID = elevenLabsAgentId;
  if (publicBaseUrl) process.env.PUBLIC_BASE_URL = publicBaseUrl;

  res.json({ success: true, message: "Configuration updated successfully." });
});

// ─── GET /api/openai/models ──────────────────────────────────────────────────
// Checks which Realtime models the user's API key has access to
router.get("/openai/models", async (req, res) => {
  const apiKey = req.query.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(400).json({ error: "OPENAI_API_KEY is not configured." });
  }

  try {
    const resp = await fetch("https://api.openai.com/v1/models", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(resp.status).json({ error: errText });
    }
    const data = await resp.json();
    const realtimeModels = (data.data || [])
      .filter((m) => m.id.includes("realtime"))
      .map((m) => m.id);

    console.log("[OPENAI_MODELS_CHECK] Realtime models found:", realtimeModels);

    res.json({
      realtimeModels,
      hasRealtimeAccess: realtimeModels.length > 0,
      totalModels: data.data?.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/elevenlabs/agents ──────────────────────────────────────────────
// Queries ElevenLabs API for list of Conversational AI agents
router.get("/elevenlabs/agents", async (req, res) => {
  const apiKey = req.query.apiKey || process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return res.status(400).json({
      error: "ELEVENLABS_API_KEY is not configured.",
    });
  }

  try {
    const resp = await fetch("https://api.elevenlabs.io/v1/convai/agents", {
      headers: { "xi-api-key": apiKey },
    });
    if (!resp.ok) {
      return res.status(resp.status).json({
        error: `ElevenLabs API error: ${resp.statusText}`,
      });
    }
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/elevenlabs/voices ──────────────────────────────────────────────
// Queries ElevenLabs API for list of voices
router.get("/elevenlabs/voices", async (req, res) => {
  const apiKey = req.query.apiKey || process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return res.status(400).json({
      error: "ELEVENLABS_API_KEY is not configured.",
    });
  }

  try {
    const resp = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": apiKey },
    });
    if (!resp.ok) {
      return res.status(resp.status).json({
        error: `ElevenLabs API error: ${resp.statusText}`,
      });
    }
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/calls/outbound ────────────────────────────────────────────────
// Triggers an outbound call using Twilio API, routing to specified engine
router.post("/calls/outbound", async (req, res) => {
  const {
    to,
    from,
    engine = "openai",
    voice,
    agentId,
  } = req.body;

  if (!to) {
    return res.status(400).json({ error: "Destination phone number ('to') is required." });
  }

  const twilioClient = getTwilioClient();
  if (!twilioClient) {
    return res.status(500).json({
      error: "Twilio credentials are not configured. Please provide TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.",
    });
  }

  const baseUrl = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL;
  if (!baseUrl || baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1")) {
    return res.status(400).json({
      error: `Twilio requires a public HTTPS URL to reach your server. Currently public URL is "${baseUrl || "unset"}". Set PUBLIC_BASE_URL in Settings or deploy to a public cloud like Render.`,
    });
  }

  const callerId =
    from ||
    process.env.TWILIO_PHONE_NUMBER;

  if (!callerId) {
    return res.status(400).json({
      error: "Caller ID ('from') is required or TWILIO_PHONE_NUMBER must be set in .env.",
    });
  }

  try {
    // Build the webhook callback URL for the outbound call with engine query parameters
    const params = new URLSearchParams();
    params.set("engine", engine);
    if (voice) params.set("voice", voice);
    if (agentId) params.set("agentId", agentId);

    const twimlUrl = `${baseUrl}/incoming-call?${params.toString()}`;

    console.log(`[OUTBOUND_CALL] Initiating ${engine} call to ${to} via ${callerId}...`);

    const call = await twilioClient.calls.create({
      to,
      from: callerId,
      url: twimlUrl,
      statusCallback: `${baseUrl}/call-status`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    });

    // Check if the recipient is a known user
    const user = await User.findOne({ where: { phone: to } });

    // Pre-create Call entry in database
    await Call.create({
      callSid: call.sid,
      engine,
      voice: voice || (engine === "openai" ? process.env.REALTIME_VOICE || "cedar" : "default"),
      callerPhone: callerId,
      calledPhone: to,
      direction: "outbound",
      status: "initiated",
      userId: user ? user.id : null,
    });

    res.json({
      success: true,
      callSid: call.sid,
      status: call.status,
      engine,
      to,
      from: callerId,
    });
  } catch (e) {
    console.error("[OUTBOUND_CALL_FAILED]", e);
    res.status(500).json({
      error: `Twilio call creation failed: ${e.message}`,
    });
  }
});

// ─── GET /api/calls ──────────────────────────────────────────────────────────
// List calls with engine filters & comparison metrics
router.get("/calls", async (req, res) => {
  const { engine, limit = 50 } = req.query;
  const where = {};
  if (engine) where.engine = engine;

  try {
    const calls = await Call.findAll({
      where,
      limit: parseInt(limit, 10),
      order: [["createdAt", "DESC"]],
      include: [{ model: User, as: "user", attributes: ["name", "email", "businessName"] }],
    });

    const parsedCalls = calls.map((c) => {
      let parsedTranscript = [];
      try {
        if (c.transcript) parsedTranscript = JSON.parse(c.transcript);
      } catch {}

      return {
        ...c.toJSON(),
        transcriptParsed: parsedTranscript,
      };
    });

    res.json(parsedCalls);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/calls/stats/comparison ─────────────────────────────────────────
// Aggregate stats comparing OpenAI vs ElevenLabs
router.get("/calls/stats/comparison", async (req, res) => {
  try {
    const calls = await Call.findAll({
      where: { status: "completed" },
      attributes: [
        "id",
        "engine",
        "durationSeconds",
        "timeToFirstAudioMs",
        "bargeInCount",
        "rating",
      ],
    });

    const stats = {
      openai: {
        totalCalls: 0,
        avgDurationSec: 0,
        avgLatencyMs: 0,
        avgBargeIn: 0,
        avgRating: 0,
        ratedCalls: 0,
      },
      elevenlabs: {
        totalCalls: 0,
        avgDurationSec: 0,
        avgLatencyMs: 0,
        avgBargeIn: 0,
        avgRating: 0,
        ratedCalls: 0,
      },
    };

    calls.forEach((c) => {
      const eng = c.engine === "elevenlabs" ? "elevenlabs" : "openai";
      const target = stats[eng];
      target.totalCalls += 1;
      if (c.durationSeconds) target.avgDurationSec += c.durationSeconds;
      if (c.timeToFirstAudioMs) target.avgLatencyMs += c.timeToFirstAudioMs;
      if (c.bargeInCount) target.avgBargeIn += c.bargeInCount;
      if (c.rating) {
        target.avgRating += c.rating;
        target.ratedCalls += 1;
      }
    });

    ["openai", "elevenlabs"].forEach((eng) => {
      const t = stats[eng];
      if (t.totalCalls > 0) {
        t.avgDurationSec = Math.round(t.avgDurationSec / t.totalCalls);
        t.avgLatencyMs = Math.round(t.avgLatencyMs / t.totalCalls);
        t.avgBargeIn = Number((t.avgBargeIn / t.totalCalls).toFixed(1));
      }
      if (t.ratedCalls > 0) {
        t.avgRating = Number((t.avgRating / t.ratedCalls).toFixed(1));
      }
    });

    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/calls/:callSid ─────────────────────────────────────────────────
router.get("/calls/:callSid", async (req, res) => {
  try {
    const call = await Call.findOne({
      where: { callSid: req.params.callSid },
      include: [{ model: User, as: "user" }],
    });
    if (!call) return res.status(404).json({ error: "Call not found" });

    let parsedTranscript = [];
    try {
      if (call.transcript) parsedTranscript = JSON.parse(call.transcript);
    } catch {}

    res.json({
      ...call.toJSON(),
      transcriptParsed: parsedTranscript,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/calls/:callSid/feedback ───────────────────────────────────────
// Save user rating & comparison notes for a call
router.post("/calls/:callSid/feedback", async (req, res) => {
  const { rating, comparisonNotes } = req.body;
  try {
    const [updated] = await Call.update(
      {
        rating: rating ? parseInt(rating, 10) : undefined,
        comparisonNotes,
      },
      { where: { callSid: req.params.callSid } }
    );
    if (!updated) return res.status(404).json({ error: "Call not found" });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

let cachedTestAudio = null;

// ─── GET /api/test-audio ─────────────────────────────────────────────────────
// Generates or returns 24kHz PCM speech audio for automated voice injection testing
router.get("/test-audio", async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(400).json({ error: "Missing OpenAI API Key" });

  if (cachedTestAudio) {
    return res.json({ audioBase64: cachedTestAudio });
  }

  try {
    const ttsRes = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1",
        voice: "alloy",
        input: "Hello Max, can you tell me what the processing fees are for Get Pie Pay?",
        response_format: "pcm", // 24kHz 16-bit linear PCM
      }),
    });
    if (!ttsRes.ok) {
      const errT = await ttsRes.text();
      return res.status(500).json({ error: errT });
    }
    const buf = Buffer.from(await ttsRes.arrayBuffer());
    cachedTestAudio = buf.toString("base64");
    res.json({ audioBase64: cachedTestAudio });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
