import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";
import dotenv from "dotenv";
import Call from "./models/Call.js";
import User from "./models/user.js";
import { SYSTEM_MESSAGE, buildServwavePrompt } from "./prompt.js";
import { summarizer } from "./summery.js";

dotenv.config();

const {
  OPENAI_API_KEY,
  REALTIME_VOICE = "cedar",
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  PUBLIC_BASE_URL,
} = process.env;

const MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";
const TRANSCRIPTION_MODEL =
  process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-transcribe";
const MAX_QUEUED_MEDIA_CHUNKS = 250;
const VERBOSE = process.env.ENABLE_VERBOSE_AI_STREAM_LOGS === "true";
const SAMPLE_RATE = 8000;
const MIN_ASSISTANT_AUDIO_BEFORE_BARGE_MS = 800;
const MIN_BARGE_IN_LOUD_MS = 350;
const FIXED_BARGE_IN_DBFS = -36;
const NOISE_MARGIN_DB = 12;

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

const log = (...args) =>
  console.log("[AI_STREAM]", new Date().toISOString(), ...args);

const warn = (...args) =>
  console.warn("[AI_STREAM]", new Date().toISOString(), ...args);

const err = (...args) =>
  console.error("[AI_STREAM]", new Date().toISOString(), ...args);

const shortSid = (sid) => {
  if (!sid) return null;
  const s = String(sid);
  return s.length <= 12 ? s : `${s.slice(0, 8)}...${s.slice(-4)}`;
};

function ulawToPcm16(uVal) {
  uVal = ~uVal & 0xff;

  let t = ((uVal & 0x0f) << 3) + 0x84;
  t <<= (uVal & 0x70) >> 4;

  return uVal & 0x80 ? 0x84 - t : t - 0x84;
}

function getPayloadStats(base64Payload) {
  if (!base64Payload) {
    return { dbfs: -100, durationMs: 0 };
  }

  const buf = Buffer.from(base64Payload, "base64");

  if (!buf.length) {
    return { dbfs: -100, durationMs: 0 };
  }

  let sumSquares = 0;

  for (const byte of buf) {
    const sample = ulawToPcm16(byte);
    sumSquares += sample * sample;
  }

  const rms = Math.sqrt(sumSquares / buf.length);
  const dbfs = 20 * Math.log10(Math.max(rms, 1) / 32768);
  const durationMs = (buf.length / SAMPLE_RATE) * 1000;

  return { dbfs, durationMs };
}

function createOpenAIWebSocket() {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing");

  return new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
  });
}

function buildInstructions(user) {
  const firstName = user?.name ? user.name.split(" ")[0] : "there";
  const email = user?.email || "the email address on file";
  return buildServwavePrompt({
    firstName,
    email,
    companyName: "Servwave",
  });
}

function buildSessionUpdate(user) {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      output_modalities: ["audio"],
      instructions: buildInstructions(user),
      audio: {
        input: {
          format: { type: "audio/pcmu" },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 700,
            create_response: true,
            interrupt_response: false,
          },
          transcription: {
            model: TRANSCRIPTION_MODEL,
          },
        },
        output: {
          format: { type: "audio/pcmu" },
          voice: REALTIME_VOICE,
        },
      },
    },
  };
}

function buildGreetingResponse(user) {
  const firstName = user?.name ? user.name.split(" ")[0] : "there";
  const equipment = "HVAC system";
  const address = "your property";

  const greeting = `Hi ${firstName}, this is Umer from Servwave. I'm calling about the ${equipment} we serviced at ${address}. Do you have a quick minute?`;

  return {
    type: "response.create",
    response: {
      output_modalities: ["audio"],
      instructions: `Say exactly this and nothing else: "${greeting}"`,
    },
  };
}

function getAudioPayload(delta) {
  if (!delta) return null;

  if (typeof delta === "string") {
    return delta.replace(/^data:audio\/[^;]+;base64,/, "");
  }

  if (Buffer.isBuffer(delta)) return delta.toString("base64");
  if (delta instanceof ArrayBuffer)
    return Buffer.from(delta).toString("base64");
  if (Array.isArray(delta)) return Buffer.from(delta).toString("base64");

  return null;
}

function getTranscript(msg) {
  if (typeof msg.transcript === "string" && msg.transcript.trim()) {
    return msg.transcript.trim();
  }

  const content = Array.isArray(msg.item?.content) ? msg.item.content : [];
  const part = content.find((item) => typeof item?.transcript === "string");
  return part?.transcript?.trim() || "";
}

function getResponseText(msg) {
  const outputs = Array.isArray(msg.response?.output)
    ? msg.response.output
    : [];

  for (const output of outputs) {
    const content = Array.isArray(output?.content) ? output.content : [];

    for (const part of content) {
      if (typeof part?.transcript === "string" && part.transcript.trim()) {
        return part.transcript.trim();
      }

      if (typeof part?.text === "string" && part.text.trim()) {
        return part.text.trim();
      }
    }
  }

  return "";
}

function shouldEndCall(text = "") {
  const t = String(text).toLowerCase();
  return (
    t.includes("our customer support will reach you shortly goodbye") ||
    (t.includes("someone from our office will confirm") && t.includes("thanks")) ||
    t.includes("won't be called again") ||
    t.includes("have a wonderful day, goodbye") ||
    t.includes("have a great day, goodbye")
  );
}

export function handleOpenAIMediaStream(twilioWs, req, options = {}) {
    let openaiWs;

    let streamSid = null;
    let callSid = null;
    let callerFrom = null;
    let calledTo = null;
    let knownUser = null;

    let openaiSocketOpen = false;
    let openaiSessionCreated = false;
    let twilioStarted = false;
    let userLookupDone = false;
    let sessionUpdateSent = false;
    let sessionReady = false;
    let greetingSent = false;
    let hangupScheduled = false;
    let activeResponse = false;
    let callerSpeechActive = false;
    let assistantAudioStartedAt = 0;
    let assistantPlaybackActive = false;
    let bargeInLoudMs = 0;
    let noiseFloorDbfs = -60;
    let intentionalBargeInCancel = false;
    let bargeInCooldownUntil = 0;

    let inboundMediaChunks = 0;
    let forwardedMediaChunks = 0;
    let outboundAudioChunks = 0;
    let queuedMedia = [];

    const pendingQuestions = [];
    const qaPairs = [];
    const assistantTextByResponseId = new Map();
    const startedRecordings = new Set();

    log("twilio-ws-connected", { requestUrl: req?.url || "" });

    try {
      openaiWs = createOpenAIWebSocket();
    } catch (error) {
      err("openai-ws-create-failed", error?.message || String(error));
      twilioWs.close();
      return;
    }

    const sendOpenAI = (payload) => {
      if (openaiWs.readyState !== WebSocket.OPEN) return false;

      try {
        openaiWs.send(JSON.stringify(payload));

        if (VERBOSE && payload.type !== "input_audio_buffer.append") {
          log("to-openai", {
            type: payload.type,
            callSid: shortSid(callSid),
          });
        }

        return true;
      } catch (error) {
        err("openai-send-failed", {
          callSid: shortSid(callSid),
          type: payload?.type,
          error: error?.message || String(error),
        });

        return false;
      }
    };

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

    // ─── Paced Outbound Audio Jitter Buffer (G.711 mu-law, 20ms frames) ─────
    let outboundAudioBuffer = Buffer.alloc(0);
    let pacingInterval = null;
    let isPacingActive = false;
    let pendingMarks = [];
    const FRAME_SIZE_BYTES = 160; // 20ms of 8000Hz G.711 mu-law = 160 bytes
    const PREBUFFER_BYTES = 480;  // Prebuffer 60ms (3 frames) before beginning playback to prevent underruns
    const PACING_INTERVAL_MS = 20;

    const stopAudioPacing = () => {
      if (pacingInterval) {
        clearInterval(pacingInterval);
        pacingInterval = null;
      }
      outboundAudioBuffer = Buffer.alloc(0);
      isPacingActive = false;
      pendingMarks = [];
    };

    const startAudioPacing = () => {
      if (pacingInterval) return;

      pacingInterval = setInterval(() => {
        if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) {
          stopAudioPacing();
          return;
        }

        if (outboundAudioBuffer.length === 0) {
          if (!activeResponse) {
            if (pacingInterval) {
              clearInterval(pacingInterval);
              pacingInterval = null;
            }
            isPacingActive = false;
            assistantPlaybackActive = false;
            assistantAudioStartedAt = 0;
            bargeInLoudMs = 0;

            while (pendingMarks.length > 0) {
              const markName = pendingMarks.shift();
              sendTwilio({
                event: "mark",
                streamSid,
                mark: { name: markName },
              });
            }
          }
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

        assistantPlaybackActive = true;
        if (!assistantAudioStartedAt) {
          assistantAudioStartedAt = Date.now();
        }
        outboundAudioChunks += 1;
      }, PACING_INTERVAL_MS);
    };

    const enqueueOutboundAudio = (payload) => {
      if (!payload) return;
      const rawChunk = Buffer.from(payload, "base64");
      outboundAudioBuffer = Buffer.concat([outboundAudioBuffer, rawChunk]);

      if (!isPacingActive) {
        if (outboundAudioBuffer.length >= PREBUFFER_BYTES || !activeResponse) {
          isPacingActive = true;
          startAudioPacing();
        }
      }
    };

    const clearTwilioAudio = () => {
      stopAudioPacing();
      if (!streamSid) return;

      sendTwilio({
        event: "clear",
        streamSid,
      });

      log("twilio-clear-sent", {
        callSid: shortSid(callSid),
        streamSid,
      });
    };

    const cancelAssistantForConfirmedBargeIn = (reason, meta = {}) => {
      const now = Date.now();

      if (!activeResponse && !assistantPlaybackActive) return false;
      if (now < bargeInCooldownUntil) return false;

      intentionalBargeInCancel = true;
      bargeInCooldownUntil = now + 1000;

      log("barge-in-confirmed-cancel-response", {
        callSid: shortSid(callSid),
        reason,
        ...meta,
      });

      if (activeResponse) {
        sendOpenAI({ type: "response.cancel" });
      }

      clearTwilioAudio();

      activeResponse = false;
      assistantPlaybackActive = false;
      assistantAudioStartedAt = 0;
      bargeInLoudMs = 0;

      return true;
    };

    const maybeConfigureSession = () => {
      if (sessionUpdateSent) return;

      if (
        !openaiSocketOpen ||
        !openaiSessionCreated ||
        !twilioStarted ||
        !userLookupDone
      ) {
        return;
      }

      sessionUpdateSent = true;

      log("session-update-send", {
        callSid: shortSid(callSid),
        hasKnownUser: Boolean(knownUser),
        from: callerFrom,
        to: calledTo,
        voice: REALTIME_VOICE,
      });

      sendOpenAI(buildSessionUpdate(knownUser));
    };

    const flushQueuedMedia = () => {
      if (!sessionReady || queuedMedia.length === 0) return;

      const count = queuedMedia.length;

      for (const audio of queuedMedia) {
        sendOpenAI({
          type: "input_audio_buffer.append",
          audio,
        });

        forwardedMediaChunks += 1;
      }

      queuedMedia = [];

      log("queued-media-flushed", {
        callSid: shortSid(callSid),
        count,
      });
    };

    const maybeSendGreeting = () => {
      if (greetingSent || !sessionReady || !twilioStarted) return;

      greetingSent = true;

      log("greeting-create", {
        callSid: shortSid(callSid),
        knownUser: Boolean(knownUser),
      });

      sendOpenAI(buildGreetingResponse(knownUser));
    };

    const queueOrForwardMedia = (audio) => {
      if (!audio) return;

      inboundMediaChunks += 1;

      const { dbfs, durationMs } = getPayloadStats(audio);

      if (!activeResponse && !assistantPlaybackActive && !callerSpeechActive) {
        noiseFloorDbfs = noiseFloorDbfs * 0.98 + dbfs * 0.02;
      }

      if (activeResponse || assistantPlaybackActive) {
        const assistantHasBeenAudible =
          assistantAudioStartedAt &&
          Date.now() - assistantAudioStartedAt >=
            MIN_ASSISTANT_AUDIO_BEFORE_BARGE_MS;

        const adaptiveThreshold = Math.max(
          FIXED_BARGE_IN_DBFS,
          noiseFloorDbfs + NOISE_MARGIN_DB
        );

        const loudEnough = dbfs >= adaptiveThreshold;

        if (assistantHasBeenAudible && callerSpeechActive && loudEnough) {
          bargeInLoudMs += durationMs;
        } else {
          bargeInLoudMs = Math.max(0, bargeInLoudMs - durationMs * 1.5);
        }

        if (bargeInLoudMs >= MIN_BARGE_IN_LOUD_MS) {
          cancelAssistantForConfirmedBargeIn("sustained_loud_user_audio", {
            dbfs: Number(dbfs.toFixed(1)),
            noiseFloorDbfs: Number(noiseFloorDbfs.toFixed(1)),
            adaptiveThreshold: Number(adaptiveThreshold.toFixed(1)),
            bargeInLoudMs: Number(bargeInLoudMs.toFixed(0)),
          });
        }
      }

      if (sessionReady && openaiWs.readyState === WebSocket.OPEN) {
        sendOpenAI({
          type: "input_audio_buffer.append",
          audio,
        });

        forwardedMediaChunks += 1;
        return;
      }

      if (queuedMedia.length >= MAX_QUEUED_MEDIA_CHUNKS) {
        queuedMedia.shift();
      }

      queuedMedia.push(audio);
    };

    const scheduleHangup = () => {
      if (hangupScheduled || !callSid) return;

      hangupScheduled = true;

      log("hangup-scheduled-after-final-signoff", {
        callSid: shortSid(callSid),
      });

      setTimeout(() => {
        if (!twilioClient) return;

        twilioClient
          .calls(callSid)
          .update({ status: "completed" })
          .then(() => {
            log("hangup-completed", {
              callSid: shortSid(callSid),
            });
          })
          .catch((error) => {
            err("hangup-failed", {
              callSid: shortSid(callSid),
              error: error?.message || String(error),
            });
          });
      }, 8000);
    };

    openaiWs.on("open", () => {
      openaiSocketOpen = true;

      log("openai-ws-open", {
        callSid: shortSid(callSid),
        model: MODEL,
        transcriptionModel: TRANSCRIPTION_MODEL,
      });

      maybeConfigureSession();
    });

    openaiWs.on("message", (raw) => {
      let msg;

      try {
        msg = JSON.parse(raw);
      } catch (error) {
        err("openai-message-parse-failed", error?.message || String(error));
        return;
      }

      const important = [
        "session.created",
        "session.updated",
        "error",
        "response.created",
        "response.done",
        "response.failed",
        "response.canceled",
        "input_audio_buffer.speech_started",
        "input_audio_buffer.speech_stopped",
        "input_audio_buffer.committed",
        "conversation.item.input_audio_transcription.completed",
        "response.output_audio.delta",
        "response.audio.delta",
        "response.output_audio_transcript.done",
      ];

      if (important.includes(msg.type)) {
        log("from-openai", {
          type: msg.type,
          callSid: shortSid(callSid),
          itemId: msg.item_id || msg.item?.id || null,
          responseId: msg.response_id || msg.response?.id || null,
          error: msg.error?.message || msg.error || null,
        });
      }

      if (msg.type === "session.created") {
        openaiSessionCreated = true;
        maybeConfigureSession();
        return;
      }

      if (msg.type === "session.updated") {
        sessionReady = true;

        log("session-ready", {
          callSid: shortSid(callSid),
          queuedMediaChunks: queuedMedia.length,
        });

        flushQueuedMedia();
        maybeSendGreeting();
        return;
      }

      if (msg.type === "response.canceled") {
        activeResponse = false;

        log("openai-response-canceled", {
          callSid: shortSid(callSid),
          intentionalBargeInCancel,
        });

        intentionalBargeInCancel = false;
        return;
      }

      if (msg.type === "error" || msg.type === "response.failed") {
        activeResponse = false;

        err("openai-response-error", {
          callSid: shortSid(callSid),
          type: msg.type,
          error:
            msg.error?.message ||
            msg.error ||
            msg.response?.status_details ||
            null,
        });

        return;
      }

      if (msg.type === "response.created") {
        activeResponse = true;
        assistantAudioStartedAt = 0;
        bargeInLoudMs = 0;
        intentionalBargeInCancel = false;
        return;
      }

      if (msg.type === "input_audio_buffer.speech_started") {
        callerSpeechActive = true;

        log("caller-speech-started", {
          callSid: shortSid(callSid),
          activeResponse,
          assistantPlaybackActive,
        });

        return;
      }

      if (msg.type === "input_audio_buffer.speech_stopped") {
        callerSpeechActive = false;
        bargeInLoudMs = 0;

        log("caller-speech-stopped", {
          callSid: shortSid(callSid),
        });

        return;
      }

      if (
        msg.type === "conversation.item.input_audio_transcription.completed"
      ) {
        const transcript = getTranscript(msg);

        if (transcript) {
          pendingQuestions.push(transcript);

          log("caller-transcript", {
            callSid: shortSid(callSid),
            transcript,
          });
        }

        return;
      }

      if (msg.type === "response.output_audio_transcript.delta") {
        const responseId = msg.response_id || msg.response?.id || "unknown";
        const delta = typeof msg.delta === "string" ? msg.delta : "";

        if (delta) {
          assistantTextByResponseId.set(
            responseId,
            (assistantTextByResponseId.get(responseId) || "") + delta
          );
        }

        return;
      }

      if (msg.type === "response.output_audio_transcript.done") {
        const responseId = msg.response_id || msg.response?.id || "unknown";
        const transcript =
          typeof msg.transcript === "string" ? msg.transcript.trim() : "";

        if (transcript) {
          assistantTextByResponseId.set(responseId, transcript);
        }

        return;
      }

      if (
        (msg.type === "response.output_audio.delta" ||
          msg.type === "response.audio.delta") &&
        msg.delta
      ) {
        const payload = getAudioPayload(msg.delta);

        if (!payload || !streamSid) {
          warn("audio-delta-skipped", {
            callSid: shortSid(callSid),
            hasPayload: Boolean(payload),
            hasStreamSid: Boolean(streamSid),
            eventType: msg.type,
          });

          return;
        }

        // Feed to jitter buffer pacing loop for stutter-free 20ms frames
        enqueueOutboundAudio(payload);
        return;
      }

      if (msg.type === "response.done") {
        activeResponse = false;

        const responseId = msg.response?.id || msg.response_id || "unknown";

        if (streamSid && (assistantPlaybackActive || isPacingActive)) {
          pendingMarks.push(`assistant-${responseId}`);
        }

        const answer =
          getResponseText(msg) ||
          (assistantTextByResponseId.get(responseId) || "").trim();

        assistantTextByResponseId.delete(responseId);

        if (answer) {
          const question = pendingQuestions.shift() || null;

          qaPairs.push({
            q: question,
            a: answer,
          });

          log("assistant-transcript", {
            callSid: shortSid(callSid),
            transcript: answer,
          });

          if (shouldEndCall(answer)) {
            log("final-signoff-detected", {
              callSid: shortSid(callSid),
            });
            scheduleHangup();
          }
        }
      }
    });

    openaiWs.on("error", (error) => {
      err("openai-ws-error", {
        callSid: shortSid(callSid),
        error: error?.message || String(error),
      });
    });

    openaiWs.on("close", (code, reason) => {
      warn("openai-ws-close", {
        callSid: shortSid(callSid),
        code,
        reason: reason?.toString?.() || "",
        sessionReady,
        inboundMediaChunks,
        forwardedMediaChunks,
        outboundAudioChunks,
      });
    });

    twilioWs.on("message", async (raw) => {
      let data;

      try {
        data = JSON.parse(raw);
      } catch (error) {
        err("twilio-message-parse-failed", error?.message || String(error));
        return;
      }

      if (data.event === "connected") {
        log("twilio-connected-event", {
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

        log("twilio-start", {
          callSid: shortSid(callSid),
          streamSid,
          from: callerFrom,
          to: calledTo,
          customParameters: data.start?.customParameters || {},
        });

        twilioStarted = true;

        if (callSid) {
          try {
            await Call.findOrCreate({
              where: { callSid },
              defaults: {
                callSid,
                engine: "openai",
                voice: REALTIME_VOICE,
                callerPhone: callerFrom,
                calledPhone: calledTo,
                status: "in-progress",
              },
            });

            log("call-row-ready", {
              callSid: shortSid(callSid),
            });
          } catch (error) {
            err("call-row-create-failed", {
              callSid: shortSid(callSid),
              error: error?.message || String(error),
            });
          }
        }

        if (callSid && !startedRecordings.has(callSid)) {
          startedRecordings.add(callSid);

          const recordingBaseUrl = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL;
          if (recordingBaseUrl && twilioClient) {
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

              log("recording-started", {
                callSid: shortSid(callSid),
              });
            } catch (error) {
              err("recording-start-failed", {
                callSid: shortSid(callSid),
                error: error?.message || String(error),
              });
            }
          }
        }

        try {
          const lookupPhone = calledTo || callerFrom;
          knownUser = lookupPhone
            ? await User.findOne({
                where: { phone: lookupPhone },
              })
            : null;

          log("user-lookup-done", {
            callSid: shortSid(callSid),
            lookupPhone,
            found: Boolean(knownUser),
            userId: knownUser?.id || null,
          });
        } catch (error) {
          err("user-lookup-failed", {
            callSid: shortSid(callSid),
            from: callerFrom,
            error: error?.message || String(error),
          });
        }

        userLookupDone = true;
        maybeConfigureSession();
        return;
      }

      if (data.event === "media") {
        queueOrForwardMedia(data.media?.payload);
        return;
      }

      if (data.event === "mark") {
        assistantPlaybackActive = false;
        assistantAudioStartedAt = 0;
        bargeInLoudMs = 0;

        log("twilio-mark-received", {
          callSid: shortSid(callSid),
          mark: data.mark?.name || null,
        });

        return;
      }

      if (data.event === "stop") {
        log("twilio-stop", {
          callSid: shortSid(callSid),
          streamSid,
          inboundMediaChunks,
          forwardedMediaChunks,
          outboundAudioChunks,
        });

        try {
          if (openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.close();
          }
        } catch {}

        return;
      }

      if (VERBOSE) {
        log("twilio-event-unhandled", {
          event: data.event,
          callSid: shortSid(callSid),
        });
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
      log("twilio-ws-close", {
        callSid: shortSid(callSid),
        code,
        reason: reason?.toString?.() || "",
        sessionReady,
        inboundMediaChunks,
        forwardedMediaChunks,
        outboundAudioChunks,
        qaPairs: qaPairs.length,
      });

      try {
        if (openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.close();
        }
      } catch {}

      if (callSid) {
        try {
          await Call.update(
            { engine: "openai", status: "completed" },
            { where: { callSid } }
          );
        } catch {}
      }

      try {
        await summarizer(qaPairs, callSid, callerFrom);

        log("summary-created", {
          callSid: shortSid(callSid),
          qaPairs: qaPairs.length,
        });
      } catch (error) {
        err("summary-failed", {
          callSid: shortSid(callSid),
          error: error?.message || String(error),
        });
      }
    });
}

export function attachMediaStreamServer() {
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
  });

  wss.on("connection", (twilioWs, req) => {
    handleOpenAIMediaStream(twilioWs, req);
  });

  return wss;
}
