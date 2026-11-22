/**
 * seed.js — Populates SQLite database with dummy data for side-by-side comparison.
 * Run with:  node scripts/seed.js
 */

import dotenv from "dotenv";
dotenv.config();

import { syncDatabase, User, Call } from "../models/index.js";

const USERS = [
  {
    name: "Maria Gonzalez",
    email: "maria.gonzalez@freshbakery.com",
    phone: "+12025551001",
    businessName: "Fresh Bakery & Café",
    plan: "professional",
    isActive: true,
  },
  {
    name: "James Patel",
    email: "james.patel@jpizzaco.com",
    phone: "+12025551002",
    businessName: "JP Pizza Co.",
    plan: "enterprise",
    isActive: true,
  },
  {
    name: "Linda Chow",
    email: "linda@dragonwok.net",
    phone: "+12025551003",
    businessName: "Dragon Wok Restaurant",
    plan: "starter",
    isActive: true,
  },
  {
    name: "Ahmed Hassan",
    email: "ahmed.hassan@grillhouse.io",
    phone: "+12025551004",
    businessName: "Ahmed's Grill House",
    plan: "professional",
    isActive: true,
  },
  {
    name: "Sophie Turner",
    email: "sophie@turnersdeli.com",
    phone: "+12025551005",
    businessName: "Turner's Deli",
    plan: "starter",
    isActive: false,
  },
  {
    name: "Carlos Ruiz",
    email: "c.ruiz@tacospot.com",
    phone: "+12025551006",
    businessName: "Taco Spot Express",
    plan: "enterprise",
    isActive: true,
  },
];

function buildCalls(users) {
  const [maria, james, linda, ahmed, sophie, carlos] = users;

  return [
    // ── OpenAI Realtime Calls ──
    {
      callSid: "CA_OPENAI_00000000000000000000001",
      engine: "openai",
      voice: "cedar",
      callerPhone: maria.phone,
      calledPhone: "+18005559999",
      direction: "inbound",
      status: "completed",
      durationSeconds: 142,
      timeToFirstAudioMs: 720,
      bargeInCount: 1,
      rating: 4,
      comparisonNotes: "Super fast response time (~720ms). Interruption was handled cleanly, though voice modulation felt slightly robotic on numbers.",
      summary: "Maria asked about a weekend deposit delay. Resolved: deposit clears within 2 business days.",
      transcript: JSON.stringify([
        { q: "My deposit from Friday isn't showing up.", a: "Hey Maria, I see your account. That deposit typically clears in 2 business days. It should appear by tomorrow morning." },
        { q: "What if it doesn't show up?", a: "If it's still missing by tomorrow afternoon, email us at support@getpiepay.com and we'll investigate right away." },
        { q: "Keep my email.", a: "Great, I've noted that. Our customer support will reach you shortly Goodbye" },
      ]),
      recordingSid: "RE_OPENAI_001",
      recordingUrl: "https://api.twilio.com/cowbell.mp3",
      userId: maria.id,
    },
    {
      callSid: "CA_OPENAI_00000000000000000000002",
      engine: "openai",
      voice: "alloy",
      callerPhone: james.phone,
      calledPhone: "+18005559999",
      direction: "inbound",
      status: "completed",
      durationSeconds: 195,
      timeToFirstAudioMs: 690,
      bargeInCount: 2,
      rating: 4,
      comparisonNotes: "Low latency and solid turn-taking. Alloy voice sounds crisp on phone speakers.",
      summary: "James inquired about adding a kitchen printer on the Enterprise plan.",
      transcript: JSON.stringify([
        { q: "Can I add a second kitchen printer?", a: "Hey James, on your enterprise plan that's fully supported. I'll flag this for our hardware team." },
        { q: "How long will it take?", a: "Usually 1 to 2 business days. You'll receive next steps by email." },
      ]),
      recordingSid: null,
      recordingUrl: null,
      userId: james.id,
    },

    // ── ElevenLabs Conversational AI Calls ──
    {
      callSid: "CA_ELEVEN_00000000000000000000001",
      engine: "elevenlabs",
      voice: "Rachel",
      callerPhone: maria.phone,
      calledPhone: "+18005559999",
      direction: "outbound",
      status: "completed",
      durationSeconds: 160,
      timeToFirstAudioMs: 840,
      bargeInCount: 1,
      rating: 5,
      comparisonNotes: "Remarkable voice naturalness! Sounds like a real human representative with natural breath pauses and emotional warmth.",
      summary: "Follow-up call with Maria regarding POS menu setup. Rachel voice performed exceptionally well.",
      transcript: JSON.stringify([
        { q: "Hi Max, I also wanted to ask how to update my lunch menu?", a: "Hey Maria! Head over to your dashboard under Menu Management, update the prices, and tap Sync. It updates in under a minute." },
        { q: "That was so easy, thanks!", a: "You're welcome! Our customer support will reach you shortly Goodbye" },
      ]),
      recordingSid: "RE_ELEVEN_001",
      recordingUrl: "https://api.twilio.com/cowbell.mp3",
      userId: maria.id,
    },
    {
      callSid: "CA_ELEVEN_00000000000000000000002",
      engine: "elevenlabs",
      voice: "Drew",
      callerPhone: ahmed.phone,
      calledPhone: "+18005559999",
      direction: "inbound",
      status: "completed",
      durationSeconds: 180,
      timeToFirstAudioMs: 890,
      bargeInCount: 2,
      rating: 5,
      comparisonNotes: "Drew voice has great cadence. Interruption latency was smooth with ElevenLabs server-side interruption.",
      summary: "Ahmed reported an issue with receipts tax calculation. Ticket raised for support follow-up.",
      transcript: JSON.stringify([
        { q: "My receipts are showing the wrong tax rate.", a: "Hey Ahmed, I see that. I've logged an urgent support ticket for our engineering team to correct the tax profile." },
        { q: "Keep my email.", a: "Got it, confirmed. Our customer support will reach you shortly Goodbye" },
      ]),
      recordingSid: null,
      recordingUrl: null,
      userId: ahmed.id,
    },

    // ── Additional Comparative Calls ──
    {
      callSid: "CA_OPENAI_00000000000000000000003",
      engine: "openai",
      voice: "shimmer",
      callerPhone: linda.phone,
      calledPhone: "+18005559999",
      direction: "inbound",
      status: "completed",
      durationSeconds: 90,
      timeToFirstAudioMs: 760,
      bargeInCount: 0,
      rating: 4,
      comparisonNotes: "Clean flow, no barge-ins during call.",
      summary: "Linda requested guidance on tipping settings in Homebase.",
      transcript: JSON.stringify([
        { q: "Can I enable tips on the checkout screen?", a: "Hey Linda, yes! Open your Homebase settings under Checkout and toggle Enable Tip Prompt." },
      ]),
      recordingSid: null,
      recordingUrl: null,
      userId: linda.id,
    },
    {
      callSid: "CA_ELEVEN_00000000000000000000003",
      engine: "elevenlabs",
      voice: "Adam",
      callerPhone: carlos.phone,
      calledPhone: "+18005559999",
      direction: "outbound",
      status: "completed",
      durationSeconds: 120,
      timeToFirstAudioMs: 910,
      bargeInCount: 1,
      rating: 5,
      comparisonNotes: "Deep, trustworthy voice tone. Perfect for enterprise support.",
      summary: "Outbound enterprise check-in with Carlos regarding multi-terminal rollout.",
      transcript: JSON.stringify([
        { q: "How many terminals can we link?", a: "Hey Carlos, your enterprise plan supports unlimited paired terminals across all locations." },
      ]),
      recordingSid: null,
      recordingUrl: null,
      userId: carlos.id,
    },
  ];
}

async function seed() {
  console.log("🌱 Seeding database for AI Voice Bridge (OpenAI + ElevenLabs)...\n");

  await syncDatabase({ force: true });
  console.log("✅ Tables created (users, calls)\n");

  const users = await User.bulkCreate(USERS, { returning: true });
  console.log(`✅ ${users.length} users inserted`);

  const callData = buildCalls(users);
  const calls = await Call.bulkCreate(callData, { returning: true });
  console.log(`✅ ${calls.length} comparative calls inserted (OpenAI & ElevenLabs)`);

  console.log("\n🎉 Seed complete! Start the server with: npm start or npm run dev\n");
  process.exit(0);
}

seed().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
