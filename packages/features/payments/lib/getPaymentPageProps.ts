import type { GetServerSidePropsContext } from "next";
import { z } from "zod";

import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import { shouldHideBrandingForEvent } from "@calcom/features/profile/lib/hideBranding";
import prisma from "@calcom/prisma";
import { BookingStatus } from "@calcom/prisma/enums";
import { paymentDataSelect } from "@calcom/prisma/selects/payment";
import { EventTypeMetaDataSchema } from "@calcom/prisma/zod-utils";

/**
 * Loads everything /payment/[uid] needs to render.
 *
 * This is a restoration of `features/ee/payments/pages/payment.tsx`, which the
 * Cal.diy fork commit (ab21c7f805) deleted along with the whole `ee/` tree. The
 * page was left importing nothing and returning a hardcoded stub of zeros
 * (payment.data = {}, amount = 0, booking.title = ""), so the payment page
 * rendered an empty shell for EVERY payment provider and no checkout could ever
 * open. Restored here under `features/payments` rather than `ee/` so it is not
 * swept up by that deletion again.
 *
 * `clientSecret` is Stripe-only and its helper (getClientSecretFromPayment) went
 * with the ee/ tree; it is optional in the props, so it stays null. Restore it
 * alongside the helper if Stripe is ever enabled here.
 */
const querySchema = z.object({
  uid: z.string(),
});

export const getServerSideProps = async (context: GetServerSidePropsContext) => {
  const { uid } = querySchema.parse(context.query);
  const session = await getServerSession({ req: context.req });

  const rawPayment = await prisma.payment.findUnique({
    where: { uid },
    select: paymentDataSelect,
  });

  if (!rawPayment) return { notFound: true } as const;

  const { data, booking: _booking, ...restPayment } = rawPayment;
  const payment = {
    ...restPayment,
    data: data as Record<string, unknown>,
  };

  if (!_booking) return { notFound: true } as const;

  const { startTime, endTime, eventType, ...restBooking } = _booking;
  const booking = {
    ...restBooking,
    startTime: startTime.toString(),
    endTime: endTime.toString(),
  };

  if (!eventType) return { notFound: true } as const;
  if (eventType.users.length === 0 && !eventType.team) return { notFound: true } as const;

  const [user] = eventType.users.length
    ? eventType.users
    : [{ name: null, theme: null, hideBranding: null, username: null }];

  const profile = {
    name: eventType.team?.name || user?.name || null,
    theme: (!eventType.team?.name && user?.theme) || null,
    hideBranding: await shouldHideBrandingForEvent({
      eventTypeId: eventType.id,
      team: eventType.team,
      owner: eventType.users[0] ?? null,
      organizationId: session?.user?.profile?.organizationId ?? session?.user?.org?.id ?? null,
    }),
  };

  // A cancelled/rejected booking has nothing left to pay for.
  if (([BookingStatus.CANCELLED, BookingStatus.REJECTED] as BookingStatus[]).includes(
      booking.status as BookingStatus
    )) {
    return {
      redirect: { destination: `/booking/${booking.uid}`, permanent: false },
    };
  }

  return {
    props: {
      user,
      eventType: {
        ...eventType,
        metadata: EventTypeMetaDataSchema.parse(eventType.metadata),
      },
      booking,
      payment,
      clientSecret: null,
      profile,
    },
  };
};
