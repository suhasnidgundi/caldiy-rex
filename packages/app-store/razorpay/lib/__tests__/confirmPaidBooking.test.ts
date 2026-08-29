/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockHandlePaymentSuccess = vi.fn();
const mockSendBookingWhatsApp = vi.fn();
const mockUpdateMany = vi.fn();

vi.mock("@calcom/app-store/_utils/payments/handlePaymentSuccess", () => ({
  handlePaymentSuccess: mockHandlePaymentSuccess,
}));
vi.mock("@calcom/features/rex/sendBookingWhatsApp", () => ({
  sendBookingWhatsApp: mockSendBookingWhatsApp,
}));
vi.mock("@calcom/prisma", () => ({
  prisma: { payment: { updateMany: mockUpdateMany } },
}));
vi.mock("@calcom/lib/logger", () => ({
  default: { getSubLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));
vi.mock("@calcom/lib/tracing/factory", () => ({
  distributedTracing: { createTrace: () => ({}) },
}));

import { confirmPaidBooking } from "../confirmPaidBooking";

const params = { paymentId: 7, bookingId: 11, source: "verify" as const };

describe("confirmPaidBooking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateMany.mockResolvedValue({ count: 1 }); // claim won
  });

  it("still sends WhatsApp when handlePaymentSuccess signals success by throwing HttpError 200", async () => {
    // This is handlePaymentSuccess's normal exit, not a failure.
    mockHandlePaymentSuccess.mockRejectedValue(
      Object.assign(new Error("Booking with id '11' was paid and confirmed."), { statusCode: 200 })
    );

    await expect(confirmPaidBooking(params)).resolves.toBe(true);
    expect(mockSendBookingWhatsApp).toHaveBeenCalledWith(11);
    // Only the claim itself — the claim must NOT be released on success.
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("releases the claim and rethrows on a genuine failure", async () => {
    mockHandlePaymentSuccess.mockRejectedValue(new Error("calendar exploded"));

    await expect(confirmPaidBooking(params)).rejects.toThrow("calendar exploded");
    expect(mockSendBookingWhatsApp).not.toHaveBeenCalled();
    expect(mockUpdateMany).toHaveBeenCalledTimes(2); // claim + release
  });

  it("does nothing when another path already claimed the payment", async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });

    await expect(confirmPaidBooking(params)).resolves.toBe(false);
    expect(mockHandlePaymentSuccess).not.toHaveBeenCalled();
    expect(mockSendBookingWhatsApp).not.toHaveBeenCalled();
  });
});
