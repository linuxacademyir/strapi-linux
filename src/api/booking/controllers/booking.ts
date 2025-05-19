import { factories } from '@strapi/strapi';
import axios from 'axios';

interface ZarinpalPaymentRequest {
  merchant_id: string;
  amount: number;
  callback_url: string;
  description: string;
  metadata?: {
    booking_id?: string | number;
  };
}

interface ZarinpalVerifyRequest {
  merchant_id: string;
  amount: number;
  authority: string;
}

interface ZarinpalPaymentResponse {
  data?: {
    code: number;
    authority: string;
    message: string;
    [key: string]: any;
  };
  errors?: {
    message: string;
    [key: string]: any;
  };
}

interface BookingData {
  name: string;
  email: string;
  phone: string;
  hours: number | string;
  amount: number | string;
  price: number | string;
  comment?: string;
}

export default factories.createCoreController('api::booking.booking', ({ strapi }) => ({
  async create(ctx) {
    try {
      const { data } = ctx.request.body as { data: BookingData };

      // Validate required fields
      if (!data.name || !data.email || !data.phone || !data.amount || !data.hours) {
        return ctx.badRequest('Missing required fields');
      }

      // Create booking record
      const booking = await strapi.entityService.create('api::booking.booking', {
  data: {
    ...data,
    message: 'Payment initiated' // Use existing field instead of status
  }
});

      // Prepare payment request
      const paymentRequest: ZarinpalPaymentRequest = {
        merchant_id: process.env.ZARINPAL_MERCHANT_ID!,
        amount: Math.floor(Number(data.amount) * 10), // Convert toman to rial
        callback_url: process.env.ZARINPAL_CALLBACK_URL!,
        description: process.env.ZARINPAL_DESCRIPTION!,
        metadata: {
          booking_id: booking.id
        }
      };

      // Call Zarinpal API
      const paymentResponse = await axios.post<ZarinpalPaymentResponse>(
        `${process.env.ZARINPAL_BASE_URL}/payment/request.json`,
        paymentRequest,
        {
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          }
        }
      );

      const paymentData = paymentResponse.data;

      if (paymentData.data?.code !== 100) {
        throw new Error(paymentData.errors?.message || 'Payment initiation failed');
      }

      // Update booking with authority
      await strapi.entityService.update('api::booking.booking', booking.id, {
        data: {
          authority: paymentData.data.authority,
          message: paymentData.data.message
        }
      });

      return {
        paymentUrl: `https://${process.env.ZARINPAL_BASE_URL?.includes('sandbox') ? 'sandbox' : 'www'}.zarinpal.com/pg/StartPay/${paymentData.data.authority}`,
        bookingId: booking.id
      };

    } catch (error: any) {
      strapi.log.error('Booking creation error:', error);
      return ctx.badRequest(error.message || 'Booking creation failed');
    }
  },

  async verify(ctx) {
    try {
      const { authority: authParam, Status } = ctx.query as {
        authority?: string | string[];
        Status?: string;
      };

      // Handle array case for authority
      const authority = Array.isArray(authParam) ? authParam[0] : authParam;

      if (!authority) {
        return ctx.badRequest('Missing authority parameter');
      }

      // Find booking by authority
      const bookings = await strapi.entityService.findMany('api::booking.booking', {
        filters: { authority },
        limit: 1
      });

      if (!bookings || bookings.length === 0) {
        return ctx.notFound('Booking not found');
      }

      const booking = bookings[0];

      // Only verify if payment was successful
      if (Status === 'OK') {
        const verifyRequest: ZarinpalVerifyRequest = {
          merchant_id: process.env.ZARINPAL_MERCHANT_ID!,
          amount: Math.floor(Number(booking.amount) * 10),
          authority
        };

        const verifyResponse = await axios.post<ZarinpalPaymentResponse>(
          `${process.env.ZARINPAL_BASE_URL}/payment/verify.json`,
          verifyRequest,
          {
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json'
            }
          }
        );

        const verifyData = verifyResponse.data;

        // Update booking status
        const updatedBooking = await strapi.entityService.update('api::booking.booking', booking.id, {
          data: {
            status: verifyData.data?.code === 100 ? 'paid' : 'failed',
            ref_id: verifyData.data?.ref_id || null,
            message: verifyData.data?.message || verifyData.errors?.message || 'Verification failed',
            payment_data: JSON.stringify(verifyData) 
          }
        });

        return {
          success: verifyData.data?.code === 100,
          booking: updatedBooking
        };
      } else {
        // Payment failed or was cancelled
        await strapi.entityService.update('api::booking.booking', booking.id, {
          data: {
            status: 'failed',
            message: 'Payment was not completed'
          }
        });

        return {
          success: false,
          message: 'Payment was not completed'
        };
      }
    } catch (error: any) {
      strapi.log.error('Payment verification error:', error);
      return ctx.badRequest(error.message || 'Payment verification failed');
    }
  }
}));
