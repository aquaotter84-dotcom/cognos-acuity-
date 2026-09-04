// Local / self-hosted entrypoint. Vercel does NOT use this file — it imports
// server/index.js through api/index.js as a serverless handler instead.
import app from "./index.js";
import { isConfigured } from "./db.js";
import { getSystemConfig } from "./config.js";
import { createLogger } from "./shared/logging.js";

const logger = createLogger("server");
const port = Number(process.env.PORT || 3000);

app.listen(port, "0.0.0.0", () => {
  const config = getSystemConfig();
  logger.info("cognos listening", {
    port,
    model: config.models.primary,
    databaseConfigured: isConfigured(),
    gate: Boolean(process.env.COGNOS_RUNTIME_SECRET)
  });
});
