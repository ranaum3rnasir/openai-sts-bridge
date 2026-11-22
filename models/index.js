import sequelize from "../config/database.js";
import User from "./user.js";
import Call from "./Call.js";

// Sync all models in the right order
export async function syncDatabase(options = {}) {
  await sequelize.sync(options);
}

export { sequelize, User, Call };
