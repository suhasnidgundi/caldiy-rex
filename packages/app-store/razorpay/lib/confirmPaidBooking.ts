import { handlePaymentSuccess } from "@calcom/app-store/_utils/payments/handlePaymentSuccess";
import logger from "@calcom/lib/logger";
import { distributedTracing } from "@calcom/lib/tracing/factory";
import { sendBookingWhatsApp } from "@calcom/features/rex/sendBookingWhatsApp";
import { prisma } from "@calcom/prisma";

const log = logger.getSubLogger({ prefix: ["razorpay:confirmPaidBooking"] });

/**
 * Confirm a paid booking exactly once.
 *
 * Two independent paths report a successful Razorpay payment: the browser
 * calling /verify straight after checkout, and the order.paid/payment.captured
 * webhook. Either can arrive first, and both can arrive at once.
 *
 * handlePaymentSuccess is NOT idempotent — on a second run the booking is
 * already ACCEPTED, so it takes the `isConfirmed` branch and calls
 * eventManager.create(evt) again, producing a duplicate Google Calendar event
 * and a second set of confirmation emails to the customer.
 *
 * So the winner is decided in the database, not in application code: flipping
 * Payment.success false -> true is the claim. updateMany reports how many rows
 * it actually changed, and only the caller that changed one proceeds. A
 * read-then-check would leave a window for both callers to pass.
 */
export async function confirmPaidBooking(params: {
  paymentId: number;
  bookingId: number;
  source: "verify" | "webhook";
}): Promise<boolean> {
  const { paymentId, bookingId, source } = params;

  const claim = await prisma.payment.updateMany({
    where: { id: paymentId, success: false },
    data: { success: true },
  });

  if (claim.count === 0) {
    log.info("payment already confirmed elsewhere, skipping", { paymentId, bookingId, source });
    return false;
  }

  const traceContext = distributedTracing.createTrace(`razorpay_${source}`, {
    meta: { paymentId, bookingId },
  });

  try {
    await handlePaymentSuccess({ paymentId, bookingId, appSlug: "razorpay", traceContext });

    // Best-effort: the customer has paid and the booking is confirmed, so a
    // WhatsApp hiccup must never fail this call or release the claim. Anything
    // still owed is picked up by the sweep.
    try {
      await sendBookingWhatsApp(bookingId);
    } catch (waError) {
      log.error("WhatsApp send failed after confirmation; sweep will retry", { bookingId, waError });
    }

    return true;
  } catch (error) {
    // Release the claim so the other path (or a webhook retry) can try again;
    // otherwise a transient Google/SMTP failure would strand the booking as
    // paid-but-unconfirmed with nothing left to retry it.
    await prisma.payment.updateMany({
      where: { id: paymentId },
      data: { success: false },
    });
    log.error("confirmation failed, claim released for retry", { paymentId, bookingId, source, error });
    throw error;
  }
}
