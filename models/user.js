import { DataTypes } from "sequelize";
import sequelize from "../config/database.js";

/**
 * User — a registered Get Pie Pay customer.
 * Looked up by phone number on inbound call to personalise the AI session.
 */
const User = sequelize.define(
  "User",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: { isEmail: true },
    },
    phone: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      comment: "E.164 format, e.g. +12025551234",
    },
    businessName: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    plan: {
      type: DataTypes.ENUM("starter", "professional", "enterprise"),
      defaultValue: "starter",
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
  },
  {
    tableName: "users",
    timestamps: true,
  }
);

export default User;
