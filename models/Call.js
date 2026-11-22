import { DataTypes } from "sequelize";
import sequelize from "../config/database.js";
import User from "./user.js";

/**
 * Call — one record per inbound or outbound Twilio call.
 * Created when the Twilio "start" event fires or when outbound call is initiated.
 * Supports comparison between OpenAI Realtime and ElevenLabs Conversational AI.
 */
const Call = sequelize.define(
  "Call",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    callSid: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      comment: "Twilio Call SID (e.g. CA...)",
    },
    engine: {
      type: DataTypes.ENUM("openai", "elevenlabs"),
      defaultValue: "openai",
      allowNull: false,
      comment: "Voice engine used: openai (Realtime) or elevenlabs (Conversational AI)",
    },
    voice: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "Voice identifier used (e.g. cedar, alloy, Rachel, Drew)",
    },
    callerPhone: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "E.164 caller phone number",
    },
    calledPhone: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "E.164 number that was called",
    },
    direction: {
      type: DataTypes.ENUM("inbound", "outbound"),
      defaultValue: "inbound",
    },
    status: {
      type: DataTypes.ENUM(
        "initiated",
        "ringing",
        "in-progress",
        "completed",
        "failed",
        "no-answer",
        "canceled"
      ),
      defaultValue: "initiated",
    },
    summary: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: "AI-generated call summary saved after call ends",
    },
    transcript: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: "Full Q&A transcript as JSON string",
    },
    recordingSid: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "Twilio Recording SID",
    },
    recordingUrl: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    durationSeconds: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    timeToFirstAudioMs: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: "Response turnaround latency from user utterance end to first assistant audio",
    },
    bargeInCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      comment: "Number of times user interrupted assistant audio",
    },
    costEstimate: {
      type: DataTypes.FLOAT,
      allowNull: true,
      comment: "Estimated cost of call in USD based on engine pricing",
    },
    rating: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: "Manual comparison rating (1-5 stars)",
    },
    comparisonNotes: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: "User comparison notes on pronunciation, latency, naturalness",
    },
    // Foreign key — null if caller is not a known user
    userId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "users", key: "id" },
    },
  },
  {
    tableName: "calls",
    timestamps: true,
  }
);

// Associations
Call.belongsTo(User, { foreignKey: "userId", as: "user" });
User.hasMany(Call, { foreignKey: "userId", as: "calls" });

export default Call;
