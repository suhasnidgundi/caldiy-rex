import type { NextApiRequest, NextApiResponse } from "next";

import { sweepUnfulfilledWhatsApp } from "@calcom/features/rex/sendBookingWhatsApp";

/**
 * Retry WhatsApp messages still owed. Driven by cron on the host.
 *
 * Guarded by CRON_API_KEY: this triggers outbound messages to real customers,
 * so it must not be callable by anyone who finds the URL.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const apiKey = req.headers["x-api-key"] ?? req.query.apiKey;
  if (!process.env.CRON_API_KEY || apiKey !== process.env.CRON_API_KEY) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  const fulfilled = await sweepUnfulfilledWhatsApp();
  return res.status(200).json({ fulfilled });
}
