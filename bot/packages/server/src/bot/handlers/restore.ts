/**
 * Bot-driven restore: send a backup bundle to the chat, confirm, done.
 *
 * Chat-only by design — the files already live in the chat, so the confirmation UX
 * belongs there too. There is no REST equivalent.
 *
 * Admin-only for free: authMiddleware gates every handler to ADMIN_ID before this
 * one ever runs.
 *
 * The bot applies the **DB only**. Key material is root's job (the bot has no write
 * access to /etc/xray/keys by design). On a same-server restore the keys on disk are
 * already correct and the startup syncs repair everything else; on a dead-server
 * restore there is no bot yet and root is doing the work anyway.
 */

import { InlineKeyboard } from "grammy";
import * as fs from "fs";
import * as path from "path";
import { BotContext } from "../context";
import { env } from "../../config/env";
import {
  BackupBusyError,
  TELEGRAM_FETCH_LIMIT,
  backupService,
} from "../../services/backup.service";
import { createLogger } from "../../utils/logger";
import { escapeMarkdown } from "../../utils/telegram";

const logger = createLogger("restore");

const BUNDLE_NAME_RE = /^vpn-backup-.+\.enc$/i;

const MANUAL_RUNBOOK_HINT =
  "The Telegram download limit is 20 MB. Restore this bundle with the manual runbook " +
  "in README (`scripts/backup-decrypt.mjs` + `playbooks/restore.yml`).";

export async function documentInputHandler(ctx: BotContext): Promise<void> {
  const doc = ctx.message?.document;
  if (!doc) return;

  const name = doc.file_name ?? "";
  // Stay inert for anything that isn't plausibly one of our bundles: the admin
  // forwards documents to this chat for unrelated reasons. Gating on the name before
  // downloading is what keeps that cheap — the magic bytes are checked after.
  if (!BUNDLE_NAME_RE.test(name)) return;

  if ((doc.file_size ?? 0) > TELEGRAM_FETCH_LIMIT) {
    await ctx.reply(`⚠️ That bundle is too large to download here.\n\n${MANUAL_RUNBOOK_HINT}`, {
      parse_mode: "Markdown",
    });
    return;
  }

  const status = await ctx.reply("⏳ Checking the backup bundle…");
  let dest: string | null = null;

  try {
    const file = await ctx.getFile();
    if (!file.file_path) throw new Error("Telegram returned no file path for that document");

    fs.mkdirSync(backupService.stagingDir, { recursive: true, mode: 0o700 });
    dest = path.join(backupService.stagingDir, `upload-${Date.now()}.enc`);

    // Node 24 has fetch built in, so the download needs no HTTP dependency and no
    // grammY files plugin. Buffering is fine: getFile caps at 20 MB anyway.
    const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`);
    if (!res.ok) throw new Error(`Could not download the file from Telegram (HTTP ${res.status})`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()), { mode: 0o600 });

    const staged = await backupService.stageRestore(dest);
    const m = staged.manifest;

    const lines = [
      "♻️ *Restore from backup*",
      "",
      `*Created:* ${escapeMarkdown(m.created_at)}`,
      `*Node:* ${escapeMarkdown(m.label)} (${escapeMarkdown(m.host)})`,
      `*Clients in bundle:* ${staged.clientsInBundle}`,
      `*Clients right now:* ${staged.clientsCurrent}`,
      "",
    ];

    if (!staged.sameServer) {
      lines.push(
        "⚠️ *This bundle is from a different server or key set.*",
        "Only the database will be restored — the Reality keys and obfs password are " +
          "NOT applied, so existing client URIs will not match. See the DR runbook in README.",
        ""
      );
    }
    if (!m.wg_key_included && !m.standalone) {
      lines.push("⚠️ No Server A WG key in this bundle (A was unreachable at backup time).", "");
    }
    lines.push("The bot will restart to apply it. Continue?");

    await ctx.api.editMessageText(status.chat.id, status.message_id, lines.join("\n"), {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("♻️ Restore", `restore:confirm:${staged.id}`)
        .text("Cancel", `restore:cancel:${staged.id}`),
    });
  } catch (err) {
    const message = (err as Error).message;
    logger.error(`Staging failed: ${message}`);
    await ctx.api.editMessageText(
      status.chat.id,
      status.message_id,
      `❌ ${escapeMarkdown(message)}`,
      { parse_mode: "Markdown" }
    );
  } finally {
    // The staged copy is what matters from here; the raw upload is not needed.
    if (dest) fs.rmSync(dest, { force: true });
  }
}

export async function handleRestoreCallback(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";

  if (data.startsWith("restore:cancel:")) {
    await ctx.answerCallbackQuery("Cancelled");
    backupService.cancelStaged(data.replace("restore:cancel:", ""));
    await ctx.editMessageText("Restore cancelled — nothing was changed.");
    return;
  }

  if (!data.startsWith("restore:confirm:")) {
    await ctx.answerCallbackQuery("Unknown action");
    return;
  }

  const id = data.replace("restore:confirm:", "");
  const staged = backupService.getStaged(id);
  if (!staged) {
    // Staging is wiped on startup, and expires after 10 min. Both land here.
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("⌛ Restore session expired — send the file again.");
    return;
  }

  if (backupService.isRunning()) {
    await ctx.answerCallbackQuery("A backup is running — try again in a minute");
    return;
  }

  await ctx.answerCallbackQuery();
  // Say it FIRST: the process dies inside commitRestore, so nothing can be sent after.
  await ctx.editMessageText(
    `♻️ Restoring ${staged.clientsInBundle} clients — the bot will restart in a few seconds…`
  );

  try {
    await backupService.commitRestore(staged); // never returns
  } catch (err) {
    const message = err instanceof BackupBusyError ? err.message : (err as Error).message;
    logger.error(`Restore failed: ${message}`);
    await ctx.editMessageText(`❌ Restore failed: ${escapeMarkdown(message)}`, {
      parse_mode: "Markdown",
    });
  }
}
