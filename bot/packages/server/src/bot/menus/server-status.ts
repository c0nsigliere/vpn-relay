import { InlineKeyboard } from "grammy";
import { BotContext } from "../context";
import { systemService } from "../../services/system.service";
import { isStandalone } from "../../config/standalone";

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
