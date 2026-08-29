"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import z from "zod";

import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Button } from "@calcom/ui/components/button";

// The payment prop mirrors exactly what PaymentPage passes to every payment
// component; it deliberately does NOT carry the payment uid. This component is
// only ever rendered on the /payment/[uid] route, where that route param IS the
// payment uid (links are built as `/payment/${paymentUid}`), so it is read from
// the route rather than requiring a prop the page cannot supply.
interface IRazorpayPaymentComponentProps {
  payment: {
    data: unknown;
    amount: number;
    currency: string;
  };
}
/** How often to re-check whether the payment has been confirmed server-side. */
const CONFIRMATION_POLL_MS = 3000;
/** Stop polling eventually; UPI collect requests expire well inside this. */
const CONFIRMATION_POLL_TIMEOUT_MS = 120000;

const RazorpayPaymentDataSchema = z.object({
  orderId: z.string(),
  keyId: z.string(),
  amount: z.number(),
  currency: z.string(),
});

export const RazorpayPaymentComponent = (props: IRazorpayPaymentComponentProps) => {
  const { t } = useLocale();
  const { payment } = props;
  const params = useParams<{ uid: string }>();
  const paymentUid = params?.uid;
  const [scriptLoaded, setScriptLoaded] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => setScriptLoaded(true);
    document.body.appendChild(script);
    return () => {
      document.body.removeChild(script);
    };
  }, []);

  // A UPI "intent" payment hands the browser off to the customer's UPI app, and
  // coming back can tear down this page's JS context -- so Razorpay's `handler`
  // callback, the only thing that navigates to the booking, never runs. The
  // payment still completes and the webhook still confirms it server-side, so
  // without this the customer sits on a "Pay" button they already paid, and only
  // a manual refresh reveals the booking.
  //
  // This component is rendered only while the payment is unconfirmed, so simply
  // re-fetching the server view is enough: once it reports success the parent
  // stops rendering us and the paid state appears on its own.
  useEffect(() => {
    let elapsed = 0;
    const id = setInterval(() => {
      elapsed += CONFIRMATION_POLL_MS;
      if (elapsed >= CONFIRMATION_POLL_TIMEOUT_MS) {
        clearInterval(id);
        return;
      }
      router.refresh();
    }, CONFIRMATION_POLL_MS);
    return () => clearInterval(id);
  }, [router]);

  const parsedData = RazorpayPaymentDataSchema.safeParse(payment.data);

  if (!parsedData.success) {
    return <p className="mt-3 text-center">{t("Payment data error")}</p>;
  }
  const { orderId, keyId, amount, currency } = parsedData.data;
  const handlePayment = () => {
    const options = {
      key: keyId,
      amount: amount,
      currency: currency,
      order_id: orderId,
      name: "Cal.com",
      description: t("Event Booking Payment"),
      handler: function (response: {
        razorpay_payment_id: string;
        razorpay_order_id: string;
        razorpay_signature: string;
      }) {
        fetch("/api/integrations/razorpay/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_order_id: response.razorpay_order_id,
            razorpay_signature: response.razorpay_signature,
            paymentUid,
          }),
        })
          .then((res) => res.json())
          .then((data) => {
            if (data.bookingUid) {
              window.location.href = `/booking/${data.bookingUid}`;
            } else {
              window.location.reload();
            }
          })
          .catch((error) => {
            console.error("Payment verification failed:", error);
            window.location.reload();
          });
      },
      prefill: {
        email: new URLSearchParams(window.location.search).get("email") || "",
        name: new URLSearchParams(window.location.search).get("name") || "",
      },
      theme: {
        color: "#292929",
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rzp = new (window as any).Razorpay(options);
    rzp.open();
  };
  return (
    <div className="mt-4 flex w-full flex-col items-center justify-center">
      <Button onClick={handlePayment} className="w-full" disabled={!scriptLoaded}>
        {scriptLoaded
          ? `${t("pay_amount", {
              amount: new Intl.NumberFormat(
                typeof window !== "undefined" ? window.navigator.language : "en",
                {
                  style: "currency",
                  currency: currency,
                }
              ).format(amount / 100),
            })}`
          : t("Loading...")}
      </Button>
    </div>
  );
};
