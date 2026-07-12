import { InlineKeyboard } from "grammy";
import { execSync } from "child_process";
import { BotContext } from "../context";
import { systemService } from "../../services/system.service";
import { hysteriaService } from "../../services/hysteria.service";
import { isStandalone } from "../../config/standalone";
import { env } from "../../config/env";

function isServiceActive(name: string): boolean {
  try {
    execSync(`systemctl is-active ${name}`, { timeout: 4000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** Local data-plane service health on the exit host (XRay TCP + sing-box Hy2 UDP). */
async function formatExitServices(): Promise<string> {
  const lines = [`XRay: ${isServiceActive("xray") ? "✅ active" : "🔴 down"}`];
  if (env.HY2_ENABLED) {
    const up = isServiceActive("sing-box");
    const stats = up ? await hysteriaService.statsApiHealthy() : false;
    lines.push(
      `sing-box (Hy2): ${up ? "✅ active" : "🔴 down"}` +
        (up ? (stats ? " · stats API ✅" : " · stats API ⚠️") : "")
    );
  }
  return lines.join("\n");
}

function formatStatus(status: PromiseSettledResult<import("../../services/system.service").ServerStatus>, errorPrefix = "Error"): string {
  return status.status === "fulfilled"
    ? [
        `CPU: ${status.value.cpuPercent.toFixed(1)}%`,
        `RAM: ${status.value.ramUsedMb}/${status.value.ramTotalMb} MB`,
        `Uptime: ${status.value.uptime}`,
        status.value.updatesAvailable > 0
          ? `⚠️ ${status.value.updatesAvailable} updates pending`
          : "✅ Up to date",
        status.value.rebootRequired ? "🔄 Reboot required" : "",
      ]
        .filter(Boolean)
        .join("\n")
    : `❌ ${errorPrefix}: ${status.reason?.message ?? "unknown"}`;
}

export async function showServerStatus(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery?.();
  await ctx.editMessageText("⏳ Fetching server status...", {
    reply_markup: new InlineKeyboard().text("« Back", "menu:main"),
  });

  try {
    const statusB = await Promise.allSettled([systemService.getStatusB()]);
    const fmtB = formatStatus(statusB[0]);

    const sections = ["📊 *Server Status*\n"];

    if (!isStandalone) {
      const statusA = await Promise.allSettled([systemService.getStatusA()]);
      sections.push(`*Server A (entry)*\n${formatStatus(statusA[0], "Unreachable")}`, "");
    }

    sections.push(`*Server${isStandalone ? "" : " B"} (exit — this host)*\n${fmtB}`);
    sections.push("", `*Services (exit)*\n${await formatExitServices()}`);

    await ctx.editMessageText(sections.join("\n"), {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("🔄 Refresh", "menu:server_status")
        .text("« Back", "menu:main"),
    });
  } catch (err) {
    await ctx.editMessageText(`❌ Error: ${(err as Error).message}`, {
      reply_markup: new InlineKeyboard().text("« Back", "menu:main"),
    });
  }
}
