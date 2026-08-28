import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";
import { prisma } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import { confirmPaidBooking } from "../lib/confirmPaidBooking";
import logger from "@calcom/lib/logger";
import { RazorpayCredentials } from "../lib/types";
import { verifyRequestSchema } from "../zod";
const log = logger.getSubLogger({ prefix: ["razorpay-verify"] });


export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    if (req.method !== "POST") {
        return res.status(405).json({ message: "Method not allowed" });
    }
    try {
        const parseRequest = verifyRequestSchema.safeParse(req.body);
        if (!parseRequest.success) {
            return res.status(400).json({ message: "Invalid request" });
        }
        const { razorpay_payment_id, razorpay_order_id, razorpay_signature, paymentUid } = parseRequest.data;

        const payment = await prisma.payment.findFirst({
            where: { uid: paymentUid },
            select: {
                id: true,
                externalId: true,
                bookingId: true,
                data: true,
                booking: {
                    select: {
                        uid: true,
                        userId: true,
                        user: {
                            select: {
                                credentials: {
                                    where: {
                                        type: "razorpay_payment",
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });
        if (!payment) {
            log.error("Payment not found", { paymentUid });
            return res.status(404).json({ message: "Payment not found" });
        }

        if (payment.externalId !== razorpay_order_id) {
            log.error("Order ID mismatch", {
                paymentUid,
                expectedOrderId: payment.externalId,
                providedOrderId: razorpay_order_id
            });
            return res.status(400).json({ message: "Invalid order ID" });
        }

        const credentials = payment.booking?.user?.credentials?.[0];
        if (!credentials) {
            log.error("Razorpay credentials not found", { paymentUid });
            return res.status(500).json({ message: "Credentials not found" });
        }
        const razorpayCredentials = credentials.key as unknown as RazorpayCredentials;
        const keySecret = razorpayCredentials.key_secret;

        // Verification is mandatory. This was `if (keySecret && razorpay_signature)`,
        // so a request that simply omitted the signature skipped the check and still
        // got a success response -- and now that a verified call confirms the
        // booking, that would have been a free booking for anyone who could POST.
        if (!keySecret) {
            log.error("Razorpay key_secret missing, cannot verify", { paymentUid });
            return res.status(500).json({ message: "Payment verification unavailable" });
        }
        if (!razorpay_signature) {
            log.error("Missing payment signature", { paymentUid });
            return res.status(400).json({ message: "Invalid signature" });
        }

        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac("sha256", keySecret)
            .update(body)
            .digest("hex");
        const provided = Buffer.from(razorpay_signature, "utf8");
        const expected = Buffer.from(expectedSignature, "utf8");
        if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
            log.error("Invalid payment signature", { paymentUid });
            return res.status(400).json({ message: "Invalid signature" });
        }

        // Confirm here rather than waiting for the webhook. The webhook stays the
        // backup path -- confirmPaidBooking makes whichever arrives first the only
        // one that acts -- but relying on it alone means a delayed or (as was the
        // case here) unconfigured webhook leaves a paying customer with a booking
        // stuck in `pending`, no calendar invite and no email.
        if (payment.bookingId) {
            await prisma.payment.update({
                where: { id: payment.id },
                data: {
                    data: {
                        ...((payment.data as Record<string, unknown>) ?? {}),
                        paymentId: razorpay_payment_id,
                        status: "captured",
                        capturedAt: new Date().toISOString(),
                    } as unknown as Prisma.InputJsonValue,
                },
            });
            await confirmPaidBooking({
                paymentId: payment.id,
                bookingId: payment.bookingId,
                source: "verify",
            });
        }

        return res.status(200).json({
            success: true,
            bookingUid: payment.booking?.uid,
        });
    } catch (error) {
        log.error("Verification error:", error);
        return res.status(500).json({ message: "Verification failed" });
    }
}