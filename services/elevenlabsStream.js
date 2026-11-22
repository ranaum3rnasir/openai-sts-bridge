import WebSocket from "ws";
import twilio from "twilio";
import dotenv from "dotenv";
import Call from "../models/Call.js";
import User from "../models/user.js";
import { SYSTEM_MESSAGE } from "../lib/prompt.js";
import { summarizer } from "../lib/summery.js";

dotenv.config();

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  PUBLIC_BASE_URL,
} = process.env;

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

const log = (...args) =>
  console.log("[ELEVENLABS_STREAM]", new Date().toISOString(), ...args);

const warn = (...args) =>
  console.warn("[ELEVENLABS_STREAM]", new Date().toISOString(), ...args);

const err = (...args) =>
  console.error("[ELEVENLABS_STREAM]", new Date().toISOString(), ...args);

const shortSid = (sid) => {
  if (!sid) return null;
  const s = String(sid);
  return s.length <= 12 ? s : `${s.slice(0, 8)}...${s.slice(-4)}`;
};

function sampleToUlaw(pcmSample) {
  let sample = Math.max(-32768, Math.min(32767, pcmSample));
  const sign = (sample < 0) ? 0x80 : 0x00;
  if (sample < 0) sample = -sample;
  sample += 132;
  if (sample > 32767) sample = 32767;
  let exponent = 7;
  for (let exp = 0; exp < 8; exp++) {
    if (sample <= (0x00FF << (exp + 1))) {
      exponent = exp;
      break;
    }
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

function pcm16ToUlaw8k(pcm16Buf) {
  const numInputSamples = Math.floor(pcm16Buf.length / 2);
  const numOutputSamples = Math.floor(numInputSamples / 2);
  const outBuf = Buffer.alloc(numOutputSamples);

  for (let i = 0; i < numOutputSamples; i++) {
    const sample = pcm16Buf.readInt16LE(i * 4);
    outBuf[i] = sampleToUlaw(sample);
  }
  return outBuf;
}

function ulawToPcm16(uVal) {
  uVal = ~uVal & 0xff;
  let t = ((uVal & 0x0f) << 3) + 0x84;
  t <<= (uVal & 0x70) >> 4;
  return uVal & 0x80 ? 0x84 - t : t - 0x84;
}

function ulaw8kToPcm16_16k(ulawBuf) {
  const outBuf = Buffer.alloc(ulawBuf.length * 4);
  for (let i = 0; i < ulawBuf.length; i++) {
    const pcmSample = ulawToPcm16(ulawBuf[i]);
    outBuf.writeInt16LE(pcmSample, i * 4);
    outBuf.writeInt16LE(pcmSample, i * 4 + 2);
  }
  return outBuf;
}

/**
 * Get signed URL for ElevenLabs Conversational AI agent if xi-api-key is present,
 * or return the direct WebSocket endpoint.
 */
async function getElevenLabsWsUrl(agentId, apiKey) {
  if (!agentId) {
    throw new Error(
      "ELEVENLABS_AGENT_ID is required for ElevenLabs Conversational AI. Configure it in .env or the Demo UI."
    );
  }

  // If API key is available, attempt to get an authenticated signed URL
  if (apiKey) {
    try {
      const resp = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(
          agentId
        )}`,
        {
          headers: {
            "xi-api-key": apiKey,
          },
        }
      );

      if (resp.ok) {
        const data = await resp.json();
        if (data.signed_url) {
          log("obtained-signed-url-for-agent", { agentId });
          return data.signed_url;
        }
      } else {
        warn(
          "signed-url-fetch-failed-fallback-to-public",
          resp.status,
          await resp.text().catch(() => "")
        );
      }
    } catch (e) {
      warn("signed-url-exception-fallback-to-public", e.message);
    }
  }

  // Fallback to standard public WebSocket URL for public agents
  return `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(
    agentId
  )}`;
}

/**
 * Handle incoming Twilio Media Stream connection and bridge to ElevenLabs Conversational AI
 */
export function handleElevenLabsMediaStream(twilioWs, req, options = {}) {
  const apiKey = options.apiKey || process.env.ELEVENLABS_API_KEY;
  const agentId = options.agentId || process.env.ELEVENLABS_AGENT_ID;
  const voice = options.voice || "elevenlabs-default";

  let elWs = null;
  let streamSid = null;
  let callSid = null;
  let callerFrom = null;
  let calledTo = null;
  let knownUser = null;

  let elSocketOpen = false;
  let twilioStarted = false;
  let userLookupDone = false;
  let sessionReady = false;
  let elSessionId = null;

  let inboundMediaChunks = 0;
  let forwardedMediaChunks = 0;
  let outboundAudioChunks = 0;
  let queuedMedia = [];
  let bargeInCount = 0;

  // Latency measurement
  let userSpeechEndedAt = 0;
  let firstAssistantAudioLatency = null;

  const qaPairs = [];
  let currentCallerText = "";
  let currentAssistantText = "";
  const startedRecordings = new Set();

  log("twilio-ws-connected-for-elevenlabs", {
    requestUrl: req?.url || "",
    agentId,
    hasApiKey: Boolean(apiKey),
  });

  const sendTwilio = (payload) => {
    if (twilioWs.readyState !== WebSocket.OPEN) return false;
    try {
      twilioWs.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      err("twilio-send-failed", {
        callSid: shortSid(callSid),
        event: payload?.event,
        error: error?.message || String(error),
      });
      return false;
    }
  };

  let outboundAudioBuffer = Buffer.alloc(0);
  let pacingInterval = null;
  let isPacingActive = false;
  const FRAME_SIZE_BYTES = 160; // 20ms of 8000Hz G.711 mu-law = 160 bytes
  const PREBUFFER_BYTES = 480;  // Prebuffer 60ms (3 frames)
  const PACING_INTERVAL_MS = 20;

  const stopAudioPacing = () => {
    if (pacingInterval) {
      clearInterval(pacingInterval);
      pacingInterval = null;
    }
    outboundAudioBuffer = Buffer.alloc(0);
    isPacingActive = false;
  };

  const startAudioPacing = () => {
    if (pacingInterval) return;

    pacingInterval = setInterval(() => {
      if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) {
        stopAudioPacing();
        return;
      }

      if (outboundAudioBuffer.length === 0) {
        return;
      }

      const sendLen = Math.min(outboundAudioBuffer.length, FRAME_SIZE_BYTES);
      const frame = outboundAudioBuffer.subarray(0, sendLen);
      outboundAudioBuffer = outboundAudioBuffer.subarray(sendLen);

      sendTwilio({
        event: "media",
        streamSid,
        media: { payload: frame.toString("base64") },
      });

      outboundAudioChunks += 1;
    }, PACING_INTERVAL_MS);
  };

  const enqueueOutboundAudio = (ulawChunk) => {
    if (!ulawChunk || !ulawChunk.length) return;
    outboundAudioBuffer = Buffer.concat([outboundAudioBuffer, ulawChunk]);
    if (!isPacingActive) {
      if (outboundAudioBuffer.length >= PREBUFFER_BYTES) {
        isPacingActive = true;
        startAudioPacing();
      }
    }
  };

  const clearTwilioAudio = () => {
    stopAudioPacing();
    if (!streamSid) return;
    bargeInCount += 1;
    sendTwilio({
      event: "clear",
      streamSid,
    });
    log("twilio-clear-sent-interruption", {
      callSid: shortSid(callSid),
      streamSid,
      bargeInCount,
    });
  };

  const sendElevenLabs = (payload) => {
    if (!elWs || elWs.readyState !== WebSocket.OPEN) return false;
    try {
      elWs.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      err("elevenlabs-send-failed", {
        callSid: shortSid(callSid),
        error: error?.message || String(error),
      });
      return false;
    }
  };

  const flushQueuedMedia = () => {
    if (!sessionReady || queuedMedia.length === 0) return;
    const count = queuedMedia.length;
    for (const chunk of queuedMedia) {
      sendElevenLabs({
        user_audio_chunk: chunk,
      });
      forwardedMediaChunks += 1;
    }
    queuedMedia = [];
    log("elevenlabs-queued-media-flushed", {
      callSid: shortSid(callSid),
      count,
    });
  };

  const initializeElevenLabsWs = async () => {
    try {
      const wsUrl = await getElevenLabsWsUrl(agentId, apiKey);
      log("connecting-to-elevenlabs-ws", {
        callSid: shortSid(callSid),
        url: wsUrl.split("?")[0],
      });

      elWs = new WebSocket(wsUrl);

      elWs.on("open", () => {
        elSocketOpen = true;
        log("elevenlabs-ws-open", { callSid: shortSid(callSid) });

        // Send initial client data with caller variables (dynamic_variables)
        const name = knownUser?.name || "Caller";
        const email = knownUser?.email || "Unknown";

        const initClientData = {
          type: "conversation_initiation_client_data",
          dynamic_variables: {
            user_name: name,
            user_email: email,
            caller_phone: callerFrom || "unknown",
            caller_registered: knownUser ? "true" : "false",
          },
        };

        sendElevenLabs(initClientData);
      });

      elWs.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch (e) {
          err("elevenlabs-msg-parse-error", e.message);
          return;
        }

        const msgType = msg.type;

        // 1. Initiation metadata
        if (msgType === "conversation_initiation_metadata") {
          sessionReady = true;
          elSessionId =
            msg.conversation_initiation_metadata_event?.conversation_id;
          log("elevenlabs-session-ready", {
            callSid: shortSid(callSid),
            elSessionId,
            format:
              msg.conversation_initiation_metadata_event
                ?.agent_output_audio_format,
          });
          flushQueuedMedia();
          return;
        }

        // 2. Audio output chunk from ElevenLabs -> forward to Twilio
        if (msgType === "audio") {
          const audioPayload = msg.audio_event?.audio_base_64;
          if (audioPayload && streamSid) {
            // Measure latency to first audio byte after user finishes speaking
            if (userSpeechEndedAt && !firstAssistantAudioLatency) {
              firstAssistantAudioLatency = Date.now() - userSpeechEndedAt;
              userSpeechEndedAt = 0;
              log("latency-first-audio", {
                callSid: shortSid(callSid),
                latencyMs: firstAssistantAudioLatency,
              });
            }

            const raw = Buffer.from(audioPayload, "base64");
            // ElevenLabs output format is pcm_16000 -> downsample and compand to 8kHz mu-law for Twilio
            const ulawChunk = pcm16ToUlaw8k(raw);
            enqueueOutboundAudio(ulawChunk);
          }
          return;
        }

        // 3. Interruption / barge-in event
        if (msgType === "interruption") {
          log("elevenlabs-interruption-detected", {
            callSid: shortSid(callSid),
            eventId: msg.interruption_event?.event_id,
          });
          clearTwilioAudio();
          return;
        }

        // 4. Ping keepalive from ElevenLabs -> must reply with pong
        if (msgType === "ping") {
          const eventId = msg.ping_event?.event_id;
          sendElevenLabs({
            type: "pong",
            event_id: eventId,
          });
          return;
        }

        // 5. User transcription event
        if (msgType === "user_transcript") {
          const transcript =
            msg.user_transcription_event?.user_transcript?.trim();
          if (transcript) {
            currentCallerText = transcript;
            userSpeechEndedAt = Date.now();
            log("elevenlabs-caller-transcript", {
              callSid: shortSid(callSid),
              transcript,
            });
          }
          return;
        }

        // 6. Agent response event
        if (msgType === "agent_response") {
          const agentText = msg.agent_response_event?.agent_response?.trim();
          if (agentText) {
            currentAssistantText = agentText;
            log("elevenlabs-agent-transcript", {
              callSid: shortSid(callSid),
              transcript: agentText,
            });

            qaPairs.push({
              q: currentCallerText || null,
              a: agentText,
            });
            currentCallerText = "";

            // Check if final signoff detected
            if (
              agentText.includes(
                "Our customer support will reach you shortly Goodbye"
              ) ||
              agentText.toLowerCase().includes("goodbye")
            ) {
              log("elevenlabs-final-signoff-detected", {
                callSid: shortSid(callSid),
              });
              setTimeout(() => {
                if (twilioClient && callSid) {
                  twilioClient
                    .calls(callSid)
                    .update({ status: "completed" })
                    .catch(() => {});
                }
              }, 4000);
            }
          }
          return;
        }

        // 7. Internal error
        if (msgType === "internal_error" || msgType === "error") {
          err("elevenlabs-internal-error", {
            callSid: shortSid(callSid),
            error: msg.message || msg.error,
          });
          return;
        }
      });

      elWs.on("error", (error) => {
        err("elevenlabs-ws-error", {
          callSid: shortSid(callSid),
          error: error?.message || String(error),
        });
      });

      elWs.on("close", (code, reason) => {
        warn("elevenlabs-ws-close", {
          callSid: shortSid(callSid),
          code,
          reason: reason?.toString?.() || "",
        });
      });
    } catch (e) {
      err("elevenlabs-init-failed", e.message);
    }
  };

  // ─── Twilio WebSocket Event Handlers ─────────────────────────────────────────
  twilioWs.on("message", async (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      err("twilio-message-parse-failed", e.message);
      return;
    }

    if (data.event === "connected") {
      log("twilio-connected", {
        protocol: data.protocol,
        version: data.version,
      });
      return;
    }

    if (data.event === "start") {
      streamSid = data.start?.streamSid || null;
      callSid = data.start?.callSid || null;

      callerFrom =
        data.start?.customParameters?.from ||
        data.start?.callFrom ||
        data.start?.from ||
        null;

      calledTo = data.start?.customParameters?.to || data.start?.to || null;

      log("twilio-start-elevenlabs", {
        callSid: shortSid(callSid),
        streamSid,
        from: callerFrom,
        to: calledTo,
      });

      twilioStarted = true;

      // Create / update Call row with engine = elevenlabs in parallel with user lookup
      try {
        const lookupPhone = calledTo || callerFrom;
        const [user] = await Promise.all([
          lookupPhone ? User.findOne({ where: { phone: lookupPhone } }) : null,
          callSid
            ? Call.findOrCreate({
                where: { callSid },
                defaults: {
                  callSid,
                  engine: "elevenlabs",
                  voice,
                  callerPhone: callerFrom,
                  calledPhone: calledTo,
                  status: "in-progress",
                },
              })
            : null,
        ]);
        knownUser = user;
        userLookupDone = true;
      } catch (e) {
        err("call-setup-db-error", e.message);
      }

      // Start recording if configured
      const recordingBaseUrl = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL;
      if (
        callSid &&
        recordingBaseUrl &&
        twilioClient &&
        !startedRecordings.has(callSid)
      ) {
        startedRecordings.add(callSid);
        try {
          await twilioClient.calls(callSid).recordings.create({
            recordingStatusCallback: `${recordingBaseUrl}/recording-status`,
            recordingStatusCallbackEvent: [
              "in-progress",
              "completed",
              "absent",
            ],
            recordingChannels: "dual",
            recordingTrack: "both",
          });
          log("recording-started", { callSid: shortSid(callSid) });
        } catch (e) {
          err("recording-start-failed", e.message);
        }
      }

      // Now open ElevenLabs WebSocket with user metadata ready
      initializeElevenLabsWs();
      return;
    }

    if (data.event === "media") {
      const audioPayload = data.media?.payload;
      if (!audioPayload) return;

      inboundMediaChunks += 1;

      // Twilio sends 8kHz mu-law -> transcode to 16kHz PCM16 for ElevenLabs
      const ulawBuf = Buffer.from(audioPayload, "base64");
      const pcm16Buf = ulaw8kToPcm16_16k(ulawBuf);
      const pcm16Base64 = pcm16Buf.toString("base64");

      if (sessionReady && elWs && elWs.readyState === WebSocket.OPEN) {
        sendElevenLabs({
          user_audio_chunk: pcm16Base64,
        });
        forwardedMediaChunks += 1;
        return;
      }

      if (queuedMedia.length >= 250) {
        queuedMedia.shift();
      }
      queuedMedia.push(pcm16Base64);
      return;
    }

    if (data.event === "stop") {
      stopAudioPacing();
      log("twilio-stop-elevenlabs", {
        callSid: shortSid(callSid),
        streamSid,
        inboundMediaChunks,
        forwardedMediaChunks,
        outboundAudioChunks,
      });

      try {
        if (elWs && elWs.readyState === WebSocket.OPEN) {
          elWs.close();
        }
      } catch {}
      return;
    }
  });

  twilioWs.on("error", (error) => {
    err("twilio-ws-error", {
      callSid: shortSid(callSid),
      error: error?.message || String(error),
    });
  });

  twilioWs.on("close", async (code, reason) => {
    stopAudioPacing();
    log("twilio-ws-close-elevenlabs", {
      callSid: shortSid(callSid),
      code,
      reason: reason?.toString?.() || "",
      qaPairs: qaPairs.length,
      bargeInCount,
      timeToFirstAudioMs: firstAssistantAudioLatency,
    });

    try {
      if (elWs && elWs.readyState === WebSocket.OPEN) {
        elWs.close();
      }
    } catch {}

    // Update Call record with metrics and engine
    if (callSid) {
      try {
        await Call.update(
          {
            engine: "elevenlabs",
            status: "completed",
            bargeInCount,
            timeToFirstAudioMs: firstAssistantAudioLatency,
          },
          { where: { callSid } }
        );
      } catch (e) {
        err("failed-updating-call-metrics", e.message);
      }
    }

    // Save summary + transcript
    try {
      await summarizer(qaPairs, callSid, callerFrom);
      log("summary-saved-elevenlabs", { callSid: shortSid(callSid) });
    } catch (e) {
      err("summary-failed", e.message);
    }
  });
}
