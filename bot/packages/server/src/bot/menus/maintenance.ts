/**
 * Maintenance menu — the Update / Reboot buttons hanging off the Server Status view.
 *
 * Callback data (flat router convention, well under Telegram's 64-byte limit):
 *   maint:ask:update:<a|b>   → confirm screen offering the two update variants
 *   maint:ask:reboot:<a|b>   → confirm screen for a standalone reboot
 *   maint:go:<action>:<a|b>  → start the job
 *   maint:cancel             → back to the server status view
 *
 * `update-reboot` contains no colon, so data.split(":") stays unambiguous.
 */

import { InlineKeyboard } from "grammy";
import { BotContext } from "../context";
import { maintenanceService, MAINTENANCE_ACTIONS } from "../../services/maintenance.service";
import { escapeMarkdown } from "../../utils/telegram";
import { createLogger } from "../../utils/logger";
import type { MaintenanceAction, MaintenanceJob, ServerId } from "@vpn-relay/shared";

const logger = createLogger("maintenance-menu");

function label(server: ServerId): string {
  return `Server ${server.toUpperCase()}`;
}

/**
 * The buttons for one server, appended to the Server Status keyboard.
 * While a job runs the actions are replaced by a live status line — there is nothing
 * useful to press, and offering a button we would only reject is worse than not offering it.
 */
export function maintenanceButtons(kb: InlineKeyboard, server: ServerId): void {
  const active = maintenanceService.getActiveJob(server);
  if (active) {
    kb.row().text(`🛠 ${label(server)}: ${active.phase ?? active.status}…`, "noop");
    return;
  }
  kb.row()
    .text(`⬆️ ${label(server)}: Update`, `maint:ask:update:${server}`)
    .text(`🔄 Reboot`, `maint:ask:reboot:${server}`);
}

/** One line per server for the Server Status message body. */
export function maintenanceStatusLine(server: ServerId): string {
  const active = maintenanceService.getActiveJob(server);
  if (active) {
    return `🛠 Maintenance running: ${active.phase ?? active.status}`;
  }
  const last = maintenanceService.getLastJob(server);
  if (!last) return "";
  const icon = last.status === "succeeded" ? "✅" : last.status === "failed" ? "🔴" : "⚠️";
  const when = last.finished_at ?? last.created_at;
  return `${icon} Last maintenance: ${last.action} — ${last.status} (${when} UTC)`;
}

function confirmKeyboard(kind: "update" | "reboot", server: ServerId): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (kind === "update") {
    kb.text("Update only", `maint:go:update:${server}`).row();
    kb.text("Update + reboot if required", `maint:go:update-reboot:${server}`).row();
  } else {
    kb.text("🔄 Reboot now", `maint:go:reboot:${server}`).row();
  }
  return kb.text("« Cancel", "maint:cancel");
}

function confirmText(kind: "update" | "reboot", server: ServerId): string {
  const head = `*${escapeMarkdown(label(server))}*`;

  if (kind === "update") {
    return [
      `⬆️ ${head} — apt update + dist-upgrade`,
      "",
      "Same thing `playbooks/maintenance.yml` does, on demand.",
      "",
      "_Update only_ leaves a pending reboot pending.",
      "_Update + reboot_ reboots afterwards, but only if the system asks for one.",
    ].join("\n");
  }

  // Be honest about what the user is about to lose. For B that includes the very
  // process rendering this message.
  const consequence = server === "b"
    ? "The bot, the API and the mini app go offline for about a minute. The result will arrive here in Telegram once it is back."
    : "All WireGuard and relay clients will drop for about a minute.";

  return [`🔄 ${head} — reboot`, "", consequence].join("\n");
}

function startedText(job: MaintenanceJob): string {
  return [
    `🛠 *${escapeMarkdown(label(job.server_id))}* — ${escapeMarkdown(job.action)} started.`,
    "",
    "Progress arrives here as it happens; the mini app shows the live phase and log.",
  ].join("\n");
}

/** Handles every `maint:` callback. Owns its own answerCallbackQuery, like card:/settings:. */
export async function handleMaintenanceCallback(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const parts = data.split(":"); // maint:<verb>:<...>

  const backKb = new InlineKeyboard()
    .text("🔄 Refresh", "menu:server_status")
    .text("« Back", "menu:main");

  if (parts[1] === "cancel") {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Cancelled.", { reply_markup: backKb });
    return;
  }

  if (parts[1] === "ask") {
    const kind = parts[2] as "update" | "reboot";
    const server = parts[3] as ServerId;
    if ((kind !== "update" && kind !== "reboot") || (server !== "a" && server !== "b")) {
      await ctx.answerCallbackQuery("Unknown action");
      return;
    }
    // Cheap pre-check so we do not render a confirm screen for a job we will refuse.
    if (maintenanceService.getActiveJob(server)) {
      await ctx.answerCallbackQuery({ text: "A maintenance job is already running", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(confirmText(kind, server), {
      parse_mode: "Markdown",
      reply_markup: confirmKeyboard(kind, server),
    });
    return;
  }

  if (parts[1] === "go") {
    const action = parts[2] as MaintenanceAction;
    const server = parts[3] as ServerId;
    if (!MAINTENANCE_ACTIONS.includes(action) || (server !== "a" && server !== "b")) {
      await ctx.answerCallbackQuery("Unknown action");
      return;
    }

    // Layer 2 of the double-press protection: kills the inline-button double-tap race
    // before it ever reaches the DB. Layer 3 (the partial unique index) still backs us up.
    if (maintenanceService.getActiveJob(server)) {
      await ctx.answerCallbackQuery({ text: "A maintenance job is already running", show_alert: true });
      return;
    }

    try {
      const job = await maintenanceService.startJob(server, action, "bot");
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(startedText(job), {
        parse_mode: "Markdown",
        reply_markup: backKb,
      });
    } catch (err) {
      const message = (err as Error).message;
      logger.warn(`Could not start ${action} on ${server}: ${message}`);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(`🔴 ${escapeMarkdown(message)}`, { reply_markup: backKb });
    }
    return;
  }

  await ctx.answerCallbackQuery("Unknown action");
}
