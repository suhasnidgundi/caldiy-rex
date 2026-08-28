-- CreateTable
CREATE TABLE "RexWhatsAppDelivery" (
    "id" SERIAL NOT NULL,
    "bookingId" INTEGER NOT NULL,
    "confirmationSentAt" TIMESTAMP(3),
    "confirmationHadLink" BOOLEAN NOT NULL DEFAULT false,
    "linkFollowupSentAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "deadLetteredAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RexWhatsAppDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RexWhatsAppDelivery_bookingId_key" ON "RexWhatsAppDelivery"("bookingId");

-- CreateIndex
CREATE INDEX "RexWhatsAppDelivery_fulfilledAt_deadLetteredAt_idx" ON "RexWhatsAppDelivery"("fulfilledAt", "deadLetteredAt");

-- AddForeignKey
ALTER TABLE "RexWhatsAppDelivery" ADD CONSTRAINT "RexWhatsAppDelivery_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
