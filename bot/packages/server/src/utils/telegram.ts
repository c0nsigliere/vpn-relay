import { GrammyError } from "grammy";

/** Escape Telegram legacy Markdown specials: * _ ` [ */
export function escapeMarkdown(text: string): string {
  return text.replace(/([*_`\[])/g, "\\$1");
}

/**
 * Send a Telegram message with Markdown formatting.
 * Falls back to plain text when Telegram returns 400 (bad Markdown syntax).
 * Re-throws non-parse errors (network, rate-limit) so callers can handle them.
 */
export async function sendMarkdown(
  api: { sendMessage(chatId: number, text: string, opts?: Record<string, unknown>): Promise<unknown> },
  chatId: number,
  text: string,
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, { parse_mode: "Markdown" });
  } catch (err) {
    if (err instanceof GrammyError && err.error_code === 400) {
      await api.sendMessage(chatId, text);
      return;
    }
    throw err;
  }
}
