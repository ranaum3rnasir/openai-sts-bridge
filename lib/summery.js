/**
 * summery.js — Post-call summariser.
 * Called after the Twilio WebSocket closes with the full Q&A transcript.
 * Saves the transcript to the Call record in the database.
 */

import Call from "../models/Call.js";

/**
 * @param {Array<{q: string|null, a: string}>} qaPairs  Full Q&A transcript
 * @param {string} callSid   Twilio Call SID
 * @param {string} callerFrom  Caller's phone number (E.164)
 */
export async function summarizer(qaPairs, callSid, callerFrom) {
  if (!callSid) return;

  const transcript = JSON.stringify(qaPairs, null, 2);

  // Build a simple plain-text summary from the Q&A pairs
  const lines = qaPairs
    .filter((pair) => pair.a)
    .map((pair, i) => {
      const q = pair.q ? `Q: ${pair.q}` : "(no question captured)";
      const a = `A: ${pair.a}`;
      return `[${i + 1}] ${q}\n    ${a}`;
    });

  const summary =
    lines.length > 0
      ? `Call with ${callerFrom || "unknown"} — ${lines.length} exchange(s):\n\n${lines.join("\n\n")}`
      : `Call with ${callerFrom || "unknown"} — no transcript captured.`;

  await Call.update(
    {
      transcript,
      summary,
      status: "completed",
    },
    { where: { callSid } }
  );
}
