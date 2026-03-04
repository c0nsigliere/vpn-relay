import { FastifyInstance } from "fastify";
import { queries } from "../../db/queries";
import { tmaAuthMiddleware } from "../middleware/tma-auth";
import type { AlertSettingsResponse, PatchAlertSettingRequest } from "@vpn-relay/shared";

export async function alertsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", tmaAuthMiddleware);

  // GET /api/settings/alerts — return all alert settings
  app.get("/api/settings/alerts", async (_req, reply) => {
    const alerts = queries.getAllAlertSettings();
    const response: AlertSettingsResponse = { alerts };
    return reply.send(response);
  });

  // PATCH /api/settings/alerts/:key — partial update of one alert
  app.patch<{
    Params: { key: string };
    Body: PatchAlertSettingRequest;
  }>("/api/settings/alerts/:key", async (req, reply) => {
    const { key } = req.params;
    const existing = queries.getAlertSetting(key);
    if (!existing) {
      return reply.status(404).send({ error: "Unknown alert key" });
    }

    const { enabled, threshold, threshold2, cooldown_min } = req.body;
    const updates: PatchAlertSettingRequest = {};
    if (enabled !== undefined) updates.enabled = enabled;
    if (threshold !== undefined) updates.threshold = threshold;
    if (threshold2 !== undefined) updates.threshold2 = threshold2;
    if (cooldown_min !== undefined) updates.cooldown_min = cooldown_min;

    queries.updateAlertSetting(key, updates);
    const updated = queries.getAlertSetting(key);
    return reply.send(updated);
  });
}
