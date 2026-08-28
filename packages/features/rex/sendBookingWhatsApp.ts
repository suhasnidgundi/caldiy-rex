import logger from "@calcom/lib/logger";
import { prisma } from "@calcom/prisma";
import { BookingStatus } from "@calcom/prisma/enums";

import { isWhatsAppConfigured, normalizePhone, sendText } from "./whatsapp";

const log = logger.getSubLogger({ prefix: ["rex:whatsapp"] });

/** Tell ops early, while there is still time to fix it by hand. */
const ALERT_AFTER_ATTEMPTS = 3;
/** Hard ceiling. Past this the row is handed to a human and retries stop. */
const MAX_ATTEMPTS = 8;

function firstName(name: string): string {
  return (name ?? "").trim().split(/\s+/)[0] || "there";
}

function whenLine(startTime: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  }).format(startTime);
}

type BookingRow = NonNullable<Awaited<ReturnType<typeof loadBooking>>>;

function loadBooking(bookingId: number) {
  return prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      uid: true,
      status: true,
      paid: true,
      startTime: true,
      responses: true,
      metadata: true,
      attendees: { select: { name: true, email: true, phoneNumber: true } },
      eventType: { select: { length: true } },
      rexWhatsApp: true,
    },
  });
}

function getPhone(b: BookingRow): string | null {
  const responses = (b.responses ?? {}) as Record<string, unknown>;
  const raw =
    (typeof responses.attendeePhoneNumber === "string" ? responses.attendeePhoneNumber : null) ??
    b.attendees[0]?.phoneNumber ??
    null;
  return raw ? normalizePhone(raw) : null;
}

function getName(b: BookingRow): string {
  const responses = (b.responses ?? {}) as Record<string, unknown>;
  if (typeof responses.name === "string") return responses.name;
  return b.attendees[0]?.name ?? "";
}

function getMeetLink(b: BookingRow): string | null {
  const metadata = (b.metadata ?? {}) as Record<string, unknown>;
  return typeof metadata.videoCallUrl === "string" && metadata.videoCallUrl ? metadata.videoCallUrl : null;
}

/**
 * Send the WhatsApp messages a confirmed, paid booking is owed.
 *
 * Idempotent by design: safe to call from the payment confirmation path and
 * from the sweep, any number of times. Each message is guarded by its own
 * "already sent" column, so repeats are no-ops.
 *
 * A booking is only finished when the Meet link has actually reached the
 * customer -- either inside the confirmation, or in a follow-up. Treating
 * "confirmation sent" as done is what previously left paid customers in
 * production holding a message that promised a link which never arrived.
 *
 * Returns true when nothing further is owed.
 */
export async function sendBookingWhatsApp(bookingId: number): Promise<boolean> {
  if (!isWhatsAppConfigured()) {
    log.warn("OpenWA not configured; skipping", { bookingId });
    return false;
  }

  const b = await loadBooking(bookingId);
  if (!b) return false;
  if (b.status !== BookingStatus.ACCEPTED || !b.paid) return false;

  const state =
    b.rexWhatsApp ??
    (await prisma.rexWhatsAppDelivery.create({ data: { bookingId } }).catch(() =>
      prisma.rexWhatsAppDelivery.findUnique({ where: { bookingId } })
    ));
  if (!state) return false;
  if (state.fulfilledAt || state.deadLetteredAt) return true;

  const phone = getPhone(b);
  if (!phone) {
    // Not a transient failure: there is no channel here and never will be, so
    // retrying would burn the attempt budget for nothing.
    await prisma.rexWhatsAppDelivery.update({
      where: { bookingId },
      data: { fulfilledAt: new Date(), lastError: "no usable phone number" },
    });
    log.info("no usable phone number; nothing owed", { bookingId });
    return true;
  }

  const meetLink = getMeetLink(b);
  const name = firstName(getName(b));
  const when = whenLine(b.startTime);
  const minutes = b.eventType?.length ?? 45;

  try {
    if (!state.confirmationSentAt) {
      const linkLine = meetLink
        ? `Google Meet link: ${meetLink}`
        : "The Google Meet link will reach you here before the session.";
      await sendText(
        phone,
        `Rex Business Growth\n\nNamaskar ${name}, your Private Strategy Session is confirmed.\n\n` +
          `Date & time: ${when}\nFormat: Google Meet, both founders personally\n` +
          `Duration: ${minutes} minutes\n${linkLine}\n\n` +
          `A calendar invite has been sent to your email. Please join on time: sessions cannot be ` +
          `rescheduled, and the fee is non-refundable if the slot is missed.`
      );
      await prisma.rexWhatsAppDelivery.update({
        where: { bookingId },
        data: {
          confirmationSentAt: new Date(),
          confirmationHadLink: Boolean(meetLink),
          fulfilledAt: meetLink ? new Date() : null,
          attempts: 0,
          lastError: null,
        },
      });
      log.info("confirmation sent", { bookingId, hadLink: Boolean(meetLink) });
      return Boolean(meetLink);
    }

    // Confirmation went out link-less on an earlier pass and the link now exists.
    if (!state.confirmationHadLink && !state.linkFollowupSentAt && meetLink) {
      await sendText(
        phone,
        `Rex Business Growth\n\nNamaskar ${name}, here is your Google Meet link for the ` +
          `Private Strategy Session.\n\n${when}\n${meetLink}\n\nSee you there.`
      );
      await prisma.rexWhatsAppDelivery.update({
        where: { bookingId },
        data: { linkFollowupSentAt: new Date(), fulfilledAt: new Date(), attempts: 0, lastError: null },
      });
      log.info("owed Meet link delivered", { bookingId });
      return true;
    }

    // Confirmation sent but still no link to follow up with; stay open.
    return false;
  } catch (error) {
    const attempts = state.attempts + 1;
    const message = error instanceof Error ? error.message : String(error);
    const deadLettered = attempts >= MAX_ATTEMPTS;
    await prisma.rexWhatsAppDelivery.update({
      where: { bookingId },
      data: {
        attempts,
        lastError: message.slice(0, 500),
        deadLetteredAt: deadLettered ? new Date() : null,
      },
    });
    if (deadLettered) {
      log.error("dead-lettered after max attempts; needs a human", { bookingId, attempts, message });
    } else if (attempts >= ALERT_AFTER_ATTEMPTS) {
      log.error("repeated WhatsApp failures", { bookingId, attempts, message });
    } else {
      log.warn("WhatsApp send failed, will retry", { bookingId, attempts, message });
    }
    return false;
  }
}

/** Retry every booking still owed a message. Driven by cron. */
export async function sweepUnfulfilledWhatsApp(limit = 25): Promise<number> {
  const due = await prisma.rexWhatsAppDelivery.findMany({
    where: { fulfilledAt: null, deadLetteredAt: null, attempts: { lt: MAX_ATTEMPTS } },
    select: { bookingId: true },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
  let done = 0;
  for (const row of due) {
    if (await sendBookingWhatsApp(row.bookingId)) done++;
  }
  return done;
}
