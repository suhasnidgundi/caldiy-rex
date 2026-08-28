/**
 * OpenWA client. Ported from the Rex production service so cal.diy talks to the
 * same WhatsApp engine (container `openwa-api`) that rexbusinessgrowth.in uses.
 */
const SEND_TIMEOUT_MS = 20_000;

function getConfig() {
  const base = process.env.OPENWA_API_URL;
  const apiKey = process.env.OPENWA_API_KEY;
  const sessionId = process.env.OPENWA_SESSION_ID;
  if (!base || !apiKey || !sessionId) {
    throw new Error("OpenWA is not configured (OPENWA_API_URL/KEY/SESSION_ID).");
  }
  return { base: base.replace(/\/$/, ""), apiKey, sessionId };
}

export function isWhatsAppConfigured(): boolean {
  return Boolean(process.env.OPENWA_API_URL && process.env.OPENWA_API_KEY && process.env.OPENWA_SESSION_ID);
}

/**
 * Normalise a user-entered number to WhatsApp digits (E.164 without `+`).
 * Returns null when it cannot produce a plausible number — the caller must treat
 * that as "no WhatsApp channel", never as a send failure worth retrying.
 */
export function normalizePhone(input: string): string | null {
  let digits = String(input ?? "").replace(/\D/g, "");
  if (!digits) return null;
  const cc = process.env.OPENWA_DEFAULT_COUNTRY_CODE ?? "91";
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 10) digits = cc + digits;
  if (digits.length < 11 || digits.length > 15) return null;
  return digits;
}

export function toChatId(phoneDigits: string): string {
  return `${phoneDigits}@c.us`;
}

/** Send a plain-text WhatsApp message. Throws on failure (including timeout). */
export async function sendText(phoneDigits: string, text: string): Promise<void> {
  const cfg = getConfig();
  const res = await fetch(`${cfg.base}/api/sessions/${cfg.sessionId}/messages/send-text`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": cfg.apiKey },
    body: JSON.stringify({ chatId: toChatId(phoneDigits), text }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenWA send failed (${res.status}): ${detail.slice(0, 200)}`);
  }
}
