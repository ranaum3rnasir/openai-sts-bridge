// ─── Global State ─────────────────────────────────────────────────────────────
let currentConfig = null;
let allCalls = [];
let currentFilter = "all";
let currentMode = "browser"; // "browser" or "twilio"
let selectedCall = null;
let currentRating = 0;

// Browser Call State
let browserWs = null;
let audioContext = null;
let micStream = null;
let micProcessor = null;
let nextPlaybackTime = 0;
let activeAudioSources = [];
let liveBargeInCount = 0;

// DOM Elements
const openaiPill = document.getElementById("openaiPill");
const elevenlabsPill = document.getElementById("elevenlabsPill");
const twilioPill = document.getElementById("twilioPill");
const voiceSelect = document.getElementById("voiceSelect");
const agentIdGroup = document.getElementById("agentIdGroup");
const agentIdInput = document.getElementById("agentIdInput");
const openaiCard = document.getElementById("openaiCard");
const elevenlabsCard = document.getElementById("elevenlabsCard");

// Browser Mode Elements
const browserModePanel = document.getElementById("browserModePanel");
const twilioModePanel = document.getElementById("twilioModePanel");
const startBrowserCallBtn = document.getElementById("startBrowserCallBtn");
const endBrowserCallBtn = document.getElementById("endBrowserCallBtn");
const micIndicator = document.getElementById("micIndicator");
const browserStatusTitle = document.getElementById("browserStatusTitle");
const browserStatusDesc = document.getElementById("browserStatusDesc");
const liveSessionView = document.getElementById("liveSessionView");
const liveEngineChip = document.getElementById("liveEngineChip");
const liveLatencyChip = document.getElementById("liveLatencyChip");
const liveBargeInChip = document.getElementById("liveBargeInChip");
const liveTranscriptFeed = document.getElementById("liveTranscriptFeed");

// Twilio Mode Elements
const callLauncherForm = document.getElementById("callLauncherForm");
const fromPhoneSelect = document.getElementById("fromPhone");
const toPhoneInput = document.getElementById("toPhone");
const dialBtn = document.getElementById("dialBtn");
const hangupBtn = document.getElementById("hangupBtn");
const activeCallBanner = document.getElementById("activeCallBanner");
const callStatusText = document.getElementById("callStatusText");
const callSidLabel = document.getElementById("callSidLabel");

// Modals
const callDetailModal = document.getElementById("callDetailModal");
const closeModalBtn = document.getElementById("closeModalBtn");
const modalBackdrop = document.getElementById("modalBackdrop");
const modalTitle = document.getElementById("modalTitle");
const modalEngineBadge = document.getElementById("modalEngineBadge");
const recordingPlayerBox = document.getElementById("recordingPlayerBox");
const audioPlayer = document.getElementById("audioPlayer");
const modalSummary = document.getElementById("modalSummary");
const modalChatBubbles = document.getElementById("modalChatBubbles");
const starRating = document.getElementById("starRating");
const feedbackNotes = document.getElementById("feedbackNotes");
const saveFeedbackBtn = document.getElementById("saveFeedbackBtn");

// Settings Modal
const settingsModal = document.getElementById("settingsModal");
const openSettingsBtn = document.getElementById("openSettingsBtn");
const closeSettingsBtn = document.getElementById("closeSettingsBtn");
const settingsBackdrop = document.getElementById("settingsBackdrop");
const settingsForm = document.getElementById("settingsForm");
const callList = document.getElementById("callList");

// ─── Initial Setup ────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  setupEventListeners();
  await initMicrophoneDevices();
  await loadConfig();
  await loadCalls();
  await loadComparisonStats();
});

async function initMicrophoneDevices() {
  const select = document.getElementById("micDeviceSelect");
  if (!select || !navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter((d) => d.kind === "audioinput");
    if (audioInputs.length > 0) {
      select.innerHTML = audioInputs
        .map(
          (d, idx) =>
            `<option value="${d.deviceId}">${d.label || `Microphone ${idx + 1}`}</option>`
        )
        .join("");
    } else {
      select.innerHTML = '<option value="">Default System Microphone</option>';
    }
  } catch {
    select.innerHTML = '<option value="">Default System Microphone</option>';
  }
}

function setupEventListeners() {
  // Engine Cards
  openaiCard.addEventListener("click", () => selectEngine("openai"));
  elevenlabsCard.addEventListener("click", () => selectEngine("elevenlabs"));

  // Browser Call Buttons
  startBrowserCallBtn.addEventListener("click", startBrowserCall);
  endBrowserCallBtn.addEventListener("click", endBrowserCall);

  const injectBtn = document.getElementById("injectTestAudioBtn");
  if (injectBtn) injectBtn.addEventListener("click", injectSampleVoiceAudio);

  // Twilio Form & Hangup
  callLauncherForm.addEventListener("submit", handleTwilioCallSubmit);
  if (hangupBtn) hangupBtn.addEventListener("click", handleHangupTwilioCall);

  // Filters
  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
      e.target.classList.add("active");
      currentFilter = e.target.dataset.filter;
      renderCalls();
    });
  });

  document.getElementById("refreshCallsBtn").addEventListener("click", async () => {
    await loadCalls();
    await loadComparisonStats();
  });

  // Call Detail Modal
  closeModalBtn.addEventListener("click", closeCallModal);
  modalBackdrop.addEventListener("click", closeCallModal);

  // Star Rating
  document.querySelectorAll(".star").forEach((star) => {
    star.addEventListener("click", (e) => {
      setStarRating(parseInt(e.target.dataset.val, 10));
    });
  });

  saveFeedbackBtn.addEventListener("click", handleSaveFeedback);

  // Settings Modal
  openSettingsBtn.addEventListener("click", openSettings);
  closeSettingsBtn.addEventListener("click", closeSettings);
  settingsBackdrop.addEventListener("click", closeSettings);
  settingsForm.addEventListener("submit", handleSaveSettings);
}

// ─── Mode Switching (Browser vs Twilio) ─────────────────────────────────────────
window.switchMode = function (mode) {
  currentMode = mode;
  document.getElementById("tabBrowser").classList.toggle("active", mode === "browser");
  document.getElementById("tabTwilio").classList.toggle("active", mode === "twilio");

  browserModePanel.classList.toggle("hidden", mode !== "browser");
  twilioModePanel.classList.toggle("hidden", mode !== "twilio");
};

// ─── Engine Selection ────────────────────────────────────────────────────────
const OPENAI_VOICES = [
  { val: "cedar", label: "Cedar (Warm, natural male)" },
  { val: "alloy", label: "Alloy (Balanced, crisp)" },
  { val: "echo", label: "Echo (Warm, clear)" },
  { val: "shimmer", label: "Shimmer (Expressive, female)" },
  { val: "marin", label: "Marin (Casual, friendly)" },
];

const ELEVEN_VOICES = [
  { val: "Rachel", label: "Rachel (Calm, conversational female)" },
  { val: "Drew", label: "Drew (Young, energetic male)" },
  { val: "Adam", label: "Adam (Deep, narration male)" },
  { val: "Bella", label: "Bella (Soft, expressive female)" },
  { val: "elevenlabs-default", label: "Agent Default Voice" },
];

function selectEngine(engine) {
  if (engine === "openai") {
    openaiCard.classList.add("active");
    openaiCard.querySelector("input").checked = true;
    elevenlabsCard.classList.remove("active");
    agentIdGroup.classList.add("hidden");

    voiceSelect.innerHTML = OPENAI_VOICES.map(
      (v) => `<option value="${v.val}">${v.label}</option>`
    ).join("");
  } else {
    elevenlabsCard.classList.add("active");
    elevenlabsCard.querySelector("input").checked = true;
    openaiCard.classList.remove("active");
    agentIdGroup.classList.remove("hidden");

    voiceSelect.innerHTML = ELEVEN_VOICES.map(
      (v) => `<option value="${v.val}">${v.label}</option>`
    ).join("");

    if (currentConfig?.elevenLabsAgentId && !agentIdInput.value) {
      agentIdInput.value = currentConfig.elevenLabsAgentId;
    }
  }
}

// ─── MODE 1: In-Browser Microphone & Speaker Session (100% Localhost) ─────────
async function startBrowserCall() {
  const engine = document.querySelector('input[name="engine"]:checked').value;
  const voice = voiceSelect.value;
  const agentId = agentIdInput.value.trim();

  try {
    // 1. Request microphone access (using selected device if chosen)
    const deviceId = document.getElementById("micDeviceSelect")?.value;
    const audioConstraints = deviceId ? { deviceId: { exact: deviceId } } : true;
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
    });
    // Update device select with actual labels once permission granted
    await initMicrophoneDevices();
  } catch (err) {
    alert(`Could not access microphone: ${err.message}. Please allow mic permissions.`);
    return;
  }

  // 2. Initialize Web Audio Context at native hardware sample rate (avoids Windows/Chrome silence bug)
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  audioContext = new AudioCtx();
  await audioContext.resume();
  nextPlaybackTime = audioContext.currentTime;
  activeAudioSources = [];
  liveBargeInCount = 0;

  // 3. Update UI to In-Call state
  startBrowserCallBtn.classList.add("hidden");
  endBrowserCallBtn.classList.remove("hidden");
  micIndicator.classList.add("talking");
  browserStatusTitle.textContent = `Connecting to ${engine === "openai" ? "OpenAI Realtime" : "ElevenLabs"}...`;
  browserStatusDesc.textContent = "Establishing live duplex audio stream...";
  liveSessionView.classList.remove("hidden");
  liveTranscriptFeed.innerHTML = '<div class="feed-placeholder">Connecting to AI agent...</div>';
  liveEngineChip.textContent = `Engine: ${engine.toUpperCase()} (${voice})`;
  liveLatencyChip.textContent = "Turnaround: Waiting for speech...";
  liveBargeInChip.textContent = "Barge-ins: 0";

  // 4. Open WebSocket directly to local server
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${location.host}/browser-stream?engine=${engine}&voice=${encodeURIComponent(
    voice
  )}&agentId=${encodeURIComponent(agentId)}`;

  browserWs = new WebSocket(wsUrl);

  browserWs.onopen = () => {
    browserStatusTitle.textContent = `Connected to Max (${engine.toUpperCase()})`;
    browserStatusDesc.textContent = "Setting up audio stream...";
    liveTranscriptFeed.innerHTML = "";
  };

  browserWs.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    // Session ready from server -> initialize microphone capture with target rate
    if (msg.type === "session_ready") {
      browserStatusDesc.textContent = "Microphone live. Speak into your mic to chat!";
      const targetRate = msg.sampleRate || (engine === "openai" ? 24000 : 16000);
      setupMicrophoneCapture(audioContext, micStream, targetRate);
      return;
    }

    // Audio stream packet received -> schedule for gapless playback
    if (msg.type === "audio" && msg.audio) {
      playPcmAudioChunk(msg.audio, msg.sampleRate || 24000);
      return;
    }

    // Interruption / Barge-in -> cut off audio instantly
    if (msg.type === "interrupted") {
      stopAllAudioPlayback();
      liveBargeInCount++;
      liveBargeInChip.textContent = `Barge-ins: ${liveBargeInCount}`;
      return;
    }

    // Latency turnaround metric
    if (msg.type === "latency" && msg.latencyMs) {
      liveLatencyChip.textContent = `Turnaround: ${msg.latencyMs} ms`;
      return;
    }

    // Caller transcript
    if (msg.type === "user_transcript") {
      appendLiveBubble("user", msg.text);
      return;
    }

    // Assistant transcript
    if (msg.type === "assistant_transcript") {
      appendLiveBubble("assistant", msg.text, engine);
      return;
    }

    // Error
    if (msg.type === "error") {
      console.error("[AI_ENGINE_ERROR]", msg.message);
      appendLiveBubble("assistant", `⚠️ Engine Error: ${msg.message}`, engine);
      browserStatusTitle.textContent = "Engine Error";
      browserStatusDesc.textContent = msg.message;
      return;
    }
  };

  browserWs.onerror = (e) => {
    console.error("Browser WS error:", e);
    browserStatusTitle.textContent = "Connection error";
  };

  browserWs.onclose = () => {
    cleanUpBrowserCall();
  };
}

function setupMicrophoneCapture(ctx, stream, targetRate = 24000) {
  // Store references on window so V8 GC does not collect them
  window._micStream = stream;
  window._micSource = ctx.createMediaStreamSource(stream);
  // 4096 buffer size (~85ms at 48kHz)
  window._micProcessor = ctx.createScriptProcessor(4096, 1, 1);
  window._dummyGain = ctx.createGain();
  window._dummyGain.gain.value = 0; // Silent to prevent speaker feedback & AEC ducking

  const micLevelBar = document.getElementById("micLevelBar");
  const micDbLabel = document.getElementById("micDbLabel");
  let chunkCount = 0;

  window._micProcessor.onaudioprocess = (e) => {
    if (!browserWs || browserWs.readyState !== WebSocket.OPEN) return;

    const inputData = e.inputBuffer.getChannelData(0);

    // Compute RMS for live activity meter
    let sumSquares = 0;
    for (let i = 0; i < inputData.length; i++) {
      sumSquares += inputData[i] * inputData[i];
    }
    const rms = Math.sqrt(sumSquares / inputData.length);
    const intRms = Math.round(rms * 32768);
    if (micLevelBar) {
      const pct = Math.min(100, Math.round(rms * 500));
      micLevelBar.style.width = `${pct}%`;
      if (micDbLabel) {
        if (intRms > 150) {
          micDbLabel.textContent = `Speaking (RMS: ${intRms}) 🟢`;
          micDbLabel.style.color = "#10b981";
        } else {
          micDbLabel.textContent = `Listening... (RMS: ${intRms})`;
          micDbLabel.style.color = "var(--text-muted)";
        }
      }
    }

    // Downsample if AudioContext sample rate doesn't match targetRate
    const resampled = downsampleBuffer(inputData, ctx.sampleRate, targetRate);

    // Convert Float32 [-1.0, 1.0] to 16-bit PCM Linear
    const pcm16 = floatTo16BitPCM(resampled);
    const base64Audio = arrayBufferToBase64(pcm16.buffer);

    chunkCount++;
    if (chunkCount % 20 === 1) {
      console.log(`[MIC] chunk #${chunkCount}, rms: ${rms.toFixed(4)}, inRate: ${ctx.sampleRate}, outRate: ${targetRate}`);
    }

    browserWs.send(JSON.stringify({
      type: "audio_chunk",
      audio: base64Audio,
    }));
  };

  window._micSource.connect(window._micProcessor);
  window._micProcessor.connect(window._dummyGain);
  window._dummyGain.connect(ctx.destination);
}

function downsampleBuffer(buffer, sampleRate, outSampleRate = 24000) {
  if (outSampleRate === sampleRate) return buffer;
  const sampleRateRatio = sampleRate / outSampleRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    result[offsetResult] = count > 0 ? accum / count : (buffer[offsetBuffer] || 0);
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function floatTo16BitPCM(input) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

function playPcmAudioChunk(base64Pcm, sampleRate) {
  if (!audioContext || audioContext.state === "closed") return;

  const binaryString = window.atob(base64Pcm);
  const sampleCount = Math.floor(binaryString.length / 2);
  const float32Samples = new Float32Array(sampleCount);

  for (let i = 0; i < sampleCount; i++) {
    const byte1 = binaryString.charCodeAt(i * 2);
    const byte2 = binaryString.charCodeAt(i * 2 + 1);
    let int16 = (byte2 << 8) | byte1;
    if (int16 >= 32768) int16 -= 65536;
    float32Samples[i] = int16 / 32768.0;
  }

  const audioBuffer = audioContext.createBuffer(1, float32Samples.length, sampleRate);
  audioBuffer.copyToChannel(float32Samples, 0);

  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioContext.destination);

  // Continuous gapless scheduling
  const now = audioContext.currentTime;
  if (nextPlaybackTime < now) {
    nextPlaybackTime = now;
  }

  source.start(nextPlaybackTime);
  nextPlaybackTime += audioBuffer.duration;
  activeAudioSources.push(source);

  source.onended = () => {
    const idx = activeAudioSources.indexOf(source);
    if (idx !== -1) activeAudioSources.splice(idx, 1);
  };
}

function stopAllAudioPlayback() {
  activeAudioSources.forEach((src) => {
    try {
      src.stop();
    } catch {}
  });
  activeAudioSources = [];
  if (audioContext) {
    nextPlaybackTime = audioContext.currentTime;
  }
}

function appendLiveBubble(role, text, engine = "openai") {
  const placeholder = liveTranscriptFeed.querySelector(".feed-placeholder");
  if (placeholder) placeholder.remove();

  const bubble = document.createElement("div");
  const isAssistant = role === "assistant";
  bubble.className = `bubble ${isAssistant ? "bubble-assistant" : "bubble-user"} ${
    isAssistant && engine === "elevenlabs" ? "bubble-eleven" : ""
  }`;

  bubble.innerHTML = `
    <div class="bubble-author">${isAssistant ? `Max (${engine.toUpperCase()})` : "You (Mic)"}</div>
    ${escapeHtml(text)}
  `;

  liveTranscriptFeed.appendChild(bubble);
  liveTranscriptFeed.scrollTop = liveTranscriptFeed.scrollHeight;
}

function endBrowserCall() {
  if (browserWs) {
    browserWs.close();
  }
  cleanUpBrowserCall();
}

async function injectSampleVoiceAudio() {
  if (!browserWs || browserWs.readyState !== WebSocket.OPEN) {
    alert("Please start the in-browser call first!");
    return;
  }
  const injectBtn = document.getElementById("injectTestAudioBtn");
  if (injectBtn) injectBtn.disabled = true;

  try {
    const res = await fetch("/api/test-audio");
    const data = await res.json();
    if (!data.audioBase64) throw new Error(data.error || "No audio returned");

    const binaryString = window.atob(data.audioBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Stream in 4096-byte chunks (2048 samples at 24kHz = ~85ms)
    const chunkSize = 4096;
    let offset = 0;

    const interval = setInterval(() => {
      if (offset >= bytes.length) {
        clearInterval(interval);
        // Send trailing silence so server VAD detects end of speech
        const silenceB64 = window.btoa(String.fromCharCode(...new Uint8Array(chunkSize)));
        let sCount = 0;
        const sInterval = setInterval(() => {
          sCount++;
          if (browserWs && browserWs.readyState === WebSocket.OPEN) {
            browserWs.send(JSON.stringify({ type: "audio_chunk", audio: silenceB64 }));
          }
          if (sCount >= 12) {
            clearInterval(sInterval);
            if (injectBtn) injectBtn.disabled = false;
          }
        }, 85);
        return;
      }

      const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
      offset += chunkSize;
      let binary = "";
      for (let i = 0; i < chunk.length; i++) binary += String.fromCharCode(chunk[i]);
      const chunkB64 = window.btoa(binary);

      if (browserWs && browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(JSON.stringify({ type: "audio_chunk", audio: chunkB64 }));
      }
    }, 85);
  } catch (e) {
    alert(`Could not inject test audio: ${e.message}`);
    if (injectBtn) injectBtn.disabled = false;
  }
}

function cleanUpBrowserCall() {
  stopAllAudioPlayback();

  if (window._micProcessor) {
    try { window._micProcessor.disconnect(); } catch {}
    window._micProcessor = null;
  }
  if (window._micSource) {
    try { window._micSource.disconnect(); } catch {}
    window._micSource = null;
  }
  if (window._dummyGain) {
    try { window._dummyGain.disconnect(); } catch {}
    window._dummyGain = null;
  }
  if (micProcessor) {
    try { micProcessor.disconnect(); } catch {}
    micProcessor = null;
  }
  if (window._micStream) {
    try { window._micStream.getTracks().forEach((track) => track.stop()); } catch {}
    window._micStream = null;
  }
  if (micStream) {
    try { micStream.getTracks().forEach((track) => track.stop()); } catch {}
    micStream = null;
  }
  if (audioContext && audioContext.state !== "closed") {
    try { audioContext.close(); } catch {}
    audioContext = null;
  }

  const micLevelBar = document.getElementById("micLevelBar");
  const micDbLabel = document.getElementById("micDbLabel");
  if (micLevelBar) micLevelBar.style.width = "0%";
  if (micDbLabel) {
    micDbLabel.textContent = "Idle";
    micDbLabel.style.color = "var(--text-muted)";
  }

  startBrowserCallBtn.classList.remove("hidden");
  endBrowserCallBtn.classList.add("hidden");
  micIndicator.classList.remove("talking");
  browserStatusTitle.textContent = "Call ended";
  browserStatusDesc.textContent = "Session logged to database. Click start to test again!";

  setTimeout(async () => {
    await loadCalls();
    await loadComparisonStats();
  }, 1000);
}

// ─── MODE 2: Twilio Phone Call (Outbound) ──────────────────────────────────────
let activeTwilioCallSid = null;
let callPollingTimer = null;

async function handleTwilioCallSubmit(e) {
  e.preventDefault();

  const to = toPhoneInput.value.trim();
  const from = fromPhoneSelect.value;
  const engine = document.querySelector('input[name="engine"]:checked').value;
  const voice = voiceSelect.value;
  const agentId = agentIdInput.value.trim();

  if (!to) {
    alert("Please enter a destination phone number.");
    return;
  }

  dialBtn.disabled = true;
  dialBtn.innerHTML = "⏳ Dialing...";
  activeCallBanner.classList.remove("hidden");
  if (hangupBtn) hangupBtn.classList.remove("hidden");
  callStatusText.textContent = `Dialing ${to} via ${engine.toUpperCase()}...`;

  try {
    const res = await fetch("/api/calls/outbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, from, engine, voice, agentId }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to initiate call");

    activeTwilioCallSid = data.callSid;
    callStatusText.textContent = `Status: ${data.status.toUpperCase()}`;
    callSidLabel.textContent = `SID: ${data.callSid.slice(0, 14)}...`;

    startCallPolling(data.callSid);
    await loadCalls();
  } catch (err) {
    alert(`Twilio call error: ${err.message}`);
    activeCallBanner.classList.add("hidden");
    if (hangupBtn) hangupBtn.classList.add("hidden");
  } finally {
    dialBtn.disabled = false;
    dialBtn.innerHTML = "📞 Dial Phone via Twilio";
  }
}

async function handleHangupTwilioCall() {
  const sid = activeTwilioCallSid;
  if (hangupBtn) {
    hangupBtn.disabled = true;
    hangupBtn.innerHTML = "⏳ Ending...";
  }

  try {
    const endpoint = sid ? `/api/calls/${sid}/hangup` : "/api/calls/hangup";
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callSid: sid }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to terminate call");

    if (callPollingTimer) {
      clearInterval(callPollingTimer);
      callPollingTimer = null;
    }

    callStatusText.textContent = "Status: COMPLETED (Hung up)";
    if (hangupBtn) hangupBtn.classList.add("hidden");

    setTimeout(() => {
      activeCallBanner.classList.add("hidden");
    }, 2500);

    activeTwilioCallSid = null;
    await loadCalls();
    await loadComparisonStats();
  } catch (err) {
    alert(`Hang up failed: ${err.message}`);
  } finally {
    if (hangupBtn) {
      hangupBtn.disabled = false;
      hangupBtn.innerHTML = "🛑 Hang Up Phone Call";
    }
  }
}

function startCallPolling(callSid) {
  if (callPollingTimer) clearInterval(callPollingTimer);

  callPollingTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/calls/${callSid}`);
      if (!res.ok) return;
      const call = await res.json();

      callStatusText.textContent = `Status: ${call.status.toUpperCase()}`;
      if (["completed", "failed", "no-answer", "canceled"].includes(call.status)) {
        clearInterval(callPollingTimer);
        callPollingTimer = null;
        if (hangupBtn) hangupBtn.classList.add("hidden");
        setTimeout(() => {
          activeCallBanner.classList.add("hidden");
        }, 3000);
        activeTwilioCallSid = null;
        await loadCalls();
        await loadComparisonStats();
      }
    } catch {
      clearInterval(callPollingTimer);
      callPollingTimer = null;
    }
  }, 3000);
}

window.hangupCallBySid = async function (sid) {
  if (!confirm(`Hang up call ${sid.slice(0, 10)}...?`)) return;
  try {
    const res = await fetch(`/api/calls/${sid}/hangup`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to hang up");
    await loadCalls();
  } catch (e) {
    alert("Hang up error: " + e.message);
  }
};

// ─── Config & System Status ───────────────────────────────────────────────────
async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    currentConfig = await res.json();

    updatePill(openaiPill, currentConfig.hasOpenAI, "OpenAI");
    updatePill(elevenlabsPill, currentConfig.hasElevenLabs, "ElevenLabs");
    updatePill(twilioPill, currentConfig.hasTwilio, "Twilio", true);

    // Populate Twilio phone numbers if present
    fromPhoneSelect.innerHTML = "";
    if (currentConfig.twilioNumbers?.length > 0) {
      currentConfig.twilioNumbers.forEach((num) => {
        const opt = document.createElement("option");
        opt.value = num.phoneNumber;
        opt.textContent = `${num.phoneNumber} (${num.friendlyName})`;
        fromPhoneSelect.appendChild(opt);
      });
    } else if (currentConfig.twilioPhone) {
      const opt = document.createElement("option");
      opt.value = currentConfig.twilioPhone;
      opt.textContent = currentConfig.twilioPhone;
      fromPhoneSelect.appendChild(opt);
    } else {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "Optional — configure in Settings when testing phones";
      fromPhoneSelect.appendChild(opt);
    }

    if (currentConfig.elevenLabsAgentId && !agentIdInput.value) {
      agentIdInput.value = currentConfig.elevenLabsAgentId;
    }
  } catch (e) {
    console.error("Config fetch error:", e);
  }
}

function updatePill(el, isOk, name, isOptional = false) {
  if (isOptional && !isOk) {
    el.className = "pill pill-unknown";
    el.textContent = `${name}: Optional`;
    return;
  }
  el.className = isOk ? "pill pill-ok" : "pill pill-missing";
  el.textContent = isOk ? `✓ ${name}: Connected` : `✗ ${name}: Needs Key`;
}

// ─── Call History & Analytics ─────────────────────────────────────────────────
async function loadCalls() {
  try {
    const res = await fetch("/api/calls?limit=40");
    allCalls = await res.json();
    renderCalls();
  } catch (e) {
    callList.innerHTML = `<div class="empty-state">Error loading calls: ${e.message}</div>`;
  }
}

function renderCalls() {
  const filtered = allCalls.filter((c) => {
    if (currentFilter === "all") return true;
    return c.engine === currentFilter;
  });

  if (filtered.length === 0) {
    callList.innerHTML = `<div class="empty-state">No sessions logged for "${currentFilter}". Start a browser call above!</div>`;
    return;
  }

  callList.innerHTML = filtered
    .map((call) => {
      const date = new Date(call.createdAt).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

      const isEleven = call.engine === "elevenlabs";
      const engineBadge = isEleven
        ? `<span class="engine-badge badge-elevenlabs">ElevenLabs</span>`
        : `<span class="engine-badge badge-openai">OpenAI</span>`;

      const durationStr = call.durationSeconds
        ? `${Math.floor(call.durationSeconds / 60)}m ${call.durationSeconds % 60}s`
        : "—";

      const ratingStr = call.rating ? "★".repeat(call.rating) : "Not rated";

      const isActive = ["in-progress", "ringing", "initiated"].includes(call.status);
      const hangupRowBtn = isActive
        ? `<button class="btn-sm btn-danger" onclick="event.stopPropagation(); hangupCallBySid('${call.callSid}')" style="margin-left: 0.5rem; padding: 2px 8px; font-size: 0.74rem; border-radius: 4px; cursor: pointer;">🛑 Hang Up</button>`
        : "";

      return `
        <div class="call-item" onclick="openCallModal('${call.callSid}')">
          <div class="call-item-left">
            ${engineBadge}
            <div class="call-item-info">
              <h4>${call.user?.name || call.callerPhone || "Browser Session"} ➔ ${call.calledPhone || "AI"}</h4>
              <p>${date} • Voice: ${call.voice || "default"} • Turnaround: ${call.timeToFirstAudioMs ? `${call.timeToFirstAudioMs}ms` : "—"}</p>
            </div>
          </div>
          <div class="call-item-right">
            <span class="text-muted">${durationStr}</span>
            <span class="badge-status badge-${call.status}">${call.status}</span>
            ${hangupRowBtn}
            <span class="rating-val" style="font-size: 0.85rem;">${ratingStr}</span>
          </div>
        </div>
      `;
    })
    .join("");
}

async function loadComparisonStats() {
  try {
    const openaiLatEl = document.getElementById("openaiLatency");
    if (!openaiLatEl) return;

    const res = await fetch("/api/calls/stats/comparison");
    const stats = await res.json();

    openaiLatEl.textContent = stats.openai.avgLatencyMs
      ? `${stats.openai.avgLatencyMs} ms`
      : "~720 ms";
    if (document.getElementById("openaiBarge")) {
      document.getElementById("openaiBarge").textContent = stats.openai.avgBargeIn
        ? `${stats.openai.avgBargeIn} per session`
        : "Server VAD cancellation";
    }
    if (document.getElementById("openaiCallCount")) {
      document.getElementById("openaiCallCount").textContent = stats.openai.totalCalls;
    }
    if (document.getElementById("openaiRating")) {
      document.getElementById("openaiRating").textContent = stats.openai.avgRating
        ? `⭐ ${stats.openai.avgRating} / 5`
        : "⭐ —";
    }

    if (document.getElementById("elevenLatency")) {
      document.getElementById("elevenLatency").textContent = stats.elevenlabs.avgLatencyMs
        ? `${stats.elevenlabs.avgLatencyMs} ms`
        : "~860 ms";
    }
    if (document.getElementById("elevenBarge")) {
      document.getElementById("elevenBarge").textContent = stats.elevenlabs.avgBargeIn
        ? `${stats.elevenlabs.avgBargeIn} per session`
        : "Server-side Interruption Event";
    }
    if (document.getElementById("elevenCallCount")) {
      document.getElementById("elevenCallCount").textContent = stats.elevenlabs.totalCalls;
    }
    if (document.getElementById("elevenRating")) {
      document.getElementById("elevenRating").textContent = stats.elevenlabs.avgRating
        ? `⭐ ${stats.elevenlabs.avgRating} / 5`
        : "⭐ —";
    }
  } catch (e) {
    console.error("Stats fetch error:", e);
  }
}

// ─── Modal Details & Ratings ──────────────────────────────────────────────────
window.openCallModal = async function (callSid) {
  selectedCall = allCalls.find((c) => c.callSid === callSid);
  if (!selectedCall) return;

  modalTitle.textContent = `Session: ${selectedCall.callSid.slice(0, 18)}...`;
  const isEleven = selectedCall.engine === "elevenlabs";
  modalEngineBadge.className = isEleven ? "badge badge-elevenlabs" : "badge badge-openai";
  modalEngineBadge.textContent = isEleven ? "ElevenLabs ConvAI" : "OpenAI Realtime";

  if (selectedCall.recordingUrl) {
    recordingPlayerBox.classList.remove("hidden");
    audioPlayer.src = selectedCall.recordingUrl;
  } else {
    recordingPlayerBox.classList.add("hidden");
    audioPlayer.src = "";
  }

  modalSummary.textContent = selectedCall.summary || "No summary generated for this session.";

  const pairs = selectedCall.transcriptParsed || [];
  if (pairs.length === 0) {
    modalChatBubbles.innerHTML = '<div class="empty-state">No transcript captured.</div>';
  } else {
    modalChatBubbles.innerHTML = pairs
      .map((p) => {
        let html = "";
        if (p.q) {
          html += `<div class="bubble bubble-user"><div class="bubble-author">Caller</div>${escapeHtml(p.q)}</div>`;
        }
        if (p.a) {
          html += `<div class="bubble bubble-assistant ${isEleven ? "bubble-eleven" : ""}"><div class="bubble-author">Max (${selectedCall.engine})</div>${escapeHtml(p.a)}</div>`;
        }
        return html;
      })
      .join("");
  }

  setStarRating(selectedCall.rating || 0);
  feedbackNotes.value = selectedCall.comparisonNotes || "";
  callDetailModal.classList.remove("hidden");
};

function closeCallModal() {
  audioPlayer.pause();
  callDetailModal.classList.add("hidden");
}

function setStarRating(val) {
  currentRating = val;
  document.querySelectorAll(".star").forEach((star) => {
    const starVal = parseInt(star.dataset.val, 10);
    star.classList.toggle("selected", starVal <= val);
  });
}

async function handleSaveFeedback() {
  if (!selectedCall) return;

  saveFeedbackBtn.disabled = true;
  saveFeedbackBtn.textContent = "Saving...";

  try {
    const res = await fetch(`/api/calls/${selectedCall.callSid}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rating: currentRating,
        comparisonNotes: feedbackNotes.value,
      }),
    });

    if (res.ok) {
      selectedCall.rating = currentRating;
      selectedCall.comparisonNotes = feedbackNotes.value;
      renderCalls();
      await loadComparisonStats();
      alert("Feedback saved!");
    }
  } catch (e) {
    alert(`Error: ${e.message}`);
  } finally {
    saveFeedbackBtn.disabled = false;
    saveFeedbackBtn.textContent = "Save Rating & Notes";
  }
}

// ─── Settings Modal ───────────────────────────────────────────────────────────
function openSettings() {
  document.getElementById("cfgOpenAiKey").value = "";
  if (document.getElementById("cfgOpenAiModel")) {
    document.getElementById("cfgOpenAiModel").value = currentConfig?.openAiModel || "gpt-4o-mini-realtime-preview";
  }
  document.getElementById("cfgElevenKey").value = "";
  document.getElementById("cfgElevenAgent").value = currentConfig?.elevenLabsAgentId || "";
  document.getElementById("cfgTwilioSid").value = currentConfig?.twilioAccountSid || "";
  document.getElementById("cfgTwilioPhone").value = currentConfig?.twilioPhone || "";
  document.getElementById("cfgPublicUrl").value = currentConfig?.publicBaseUrl || "";
  settingsModal.classList.remove("hidden");
}

function closeSettings() {
  settingsModal.classList.add("hidden");
}

async function handleSaveSettings(e) {
  e.preventDefault();

  const payload = {
    openAiApiKey: document.getElementById("cfgOpenAiKey").value.trim(),
    openAiModel: document.getElementById("cfgOpenAiModel")?.value || "gpt-4o-mini-realtime-preview",
    elevenLabsApiKey: document.getElementById("cfgElevenKey").value.trim(),
    elevenLabsAgentId: document.getElementById("cfgElevenAgent").value.trim(),
    twilioAccountSid: document.getElementById("cfgTwilioSid").value.trim(),
    twilioAuthToken: document.getElementById("cfgTwilioToken").value.trim(),
    twilioPhoneNumber: document.getElementById("cfgTwilioPhone").value.trim(),
    publicBaseUrl: document.getElementById("cfgPublicUrl").value.trim(),
  };

  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      alert("Settings updated!");
      closeSettings();
      await loadConfig();
    }
  } catch (e) {
    alert(`Error: ${e.message}`);
  }
}

window.copyWebhook = function (engine) {
  const base = currentConfig?.publicBaseUrl || `http://${location.host}`;
  const url = `${base}/incoming-call?engine=${engine}`;
  navigator.clipboard.writeText(url).then(() => {
    alert(`Copied ${engine.toUpperCase()} webhook URL:\n${url}`);
  });
};

function escapeHtml(text) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
  return String(text).replace(/[&<>"']/g, (m) => map[m]);
}
