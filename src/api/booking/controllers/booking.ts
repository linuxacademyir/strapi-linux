import { factories } from '@strapi/strapi';
import axios from 'axios';

interface ZarinpalPaymentRequest {
  merchant_id: string;
  amount: number;
  callback_url: string;
  description: string;
  metadata?: {
    booking_id?: string | number;
    comment?: string;
  };
}

interface ZarinpalVerifyRequest {
  merchant_id: string;
  amount: number;
  authority: string;
}

// Zarinpal responses include a `data` object and optional `errors`
interface ZarinpalResponse<T> {
  data: T;
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
    // Validate Zarinpal configuration
    if (!process.env.ZARINPAL_MERCHANT_ID) {
      return ctx.badRequest('Missing environment variable: ZARINPAL_MERCHANT_ID');
    }
    if (!process.env.ZARINPAL_CALLBACK_URL) {
      return ctx.badRequest('Missing environment variable: ZARINPAL_CALLBACK_URL');
    }
    if (!process.env.ZARINPAL_BASE_URL) {
      return ctx.badRequest('Missing environment variable: ZARINPAL_BASE_URL');
    }
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
          booking_id: booking.id,
          comment: typeof data.comment === 'string' ? data.comment : undefined,
        }
      };

      // Call Zarinpal API
      const baseUrl = process.env.ZARINPAL_BASE_URL!.replace(/\/+$/, '');
      const paymentResponse = await axios.post<any>(
        `${baseUrl}/pg/v4/payment/request.json`,
        paymentRequest,
        {
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          }
        }
      );
      const paymentData = paymentResponse.data.data;
      const paymentError = paymentResponse.data.errors;
      if (!paymentData || paymentData.code !== 100) {
        const errMsg = paymentError?.message || 'Payment initiation failed';
        throw new Error(errMsg);
      }
      const authority = paymentData.authority as string;
      await strapi.entityService.update('api::booking.booking', booking.id, {
        data: {
          authority,
          message: `Payment initiated (code: ${paymentData.code})`
        }
      });
      const isSandbox = baseUrl.includes('sandbox');
      const redirectBase = isSandbox ? 'https://sandbox.zarinpal.com' : 'https://www.zarinpal.com';
      return {
        paymentUrl: `${redirectBase}/pg/StartPay/${authority}`,
        bookingId: booking.id
      };

    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        const { response, config } = error;
        if (response) {
          // Zarinpal endpoint not found
          if (response.status === 404) {
            const url = config?.url;
            strapi.log.error(`Zarinpal endpoint not found (404) at ${url}`);
            return ctx.badRequest(`Zarinpal endpoint not found (404) at ${url}. Please check ZARINPAL_BASE_URL environment variable.`);
          }
          // Extract Zarinpal error message
          const errMsg =
            response.data?.errors?.message ||
            response.data?.error?.message ||
            response.data?.message ||
            `Unexpected status code ${response.status}`;
          strapi.log.error(`Zarinpal request failed at ${config?.url}:`, response.data);
          return ctx.badRequest(`Zarinpal error: ${errMsg}`);
        }
        // Network / unknown axios error
        return ctx.badRequest(error.message || 'Payment request failed');
      }
      strapi.log.error('Booking creation error:', error);
      return ctx.badRequest(error.message || 'Booking creation failed');
    }
  },

  async verify(ctx) {
    try {
      const statusParam = ctx.query.Status || (ctx.query.status as string | undefined);
      const authorityParam = ctx.query.Authority || (ctx.query.authority as string | undefined);
      const Status = Array.isArray(statusParam) ? statusParam[0] : statusParam;
      const Authority = Array.isArray(authorityParam) ? authorityParam[0] : authorityParam;

      if (!Authority) {
        return ctx.badRequest('Missing Authority parameter');
      }

      // Find booking by authority
      const bookings = await strapi.entityService.findMany('api::booking.booking', {
        filters: { authority: Authority },
        limit: 1
      });

      if (!bookings || bookings.length === 0) {
        return ctx.notFound('Booking not found');
      }

      const booking = bookings[0];

      // Only verify if payment was successful
      if (Status === 'OK') {
        const verifyRequest = {
          merchant_id: process.env.ZARINPAL_MERCHANT_ID!,
          amount: Math.floor(Number(booking.amount) * 10),
          authority: Authority
        };
        const baseUrl = process.env.ZARINPAL_BASE_URL!.replace(/\/+$/, '');
        const verifyResponse = await axios.post<any>(
          `${baseUrl}/pg/v4/payment/verify.json`,
          verifyRequest,
          {
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json'
            }
          }
        );
        const verifyData = verifyResponse.data.data;
        const verifyError = verifyResponse.data.errors;
        if (!verifyData) {
          const errMsg = verifyError?.message || 'Verification failed';
          throw new Error(errMsg);
        }
        const success = verifyData.code === 100;
        const refId = verifyData.ref_id;
        const updatedBooking = await strapi.entityService.update('api::booking.booking', booking.id, {
          data: {
            status: success ? 'paid' : 'failed',
            ref_id: success && refId != null ? String(refId) : null,
            message: success ? 'Payment successful' : `Payment failed (code: ${verifyData.code})`,
            payment_data: JSON.stringify(verifyResponse.data)
          }
        });
        return { success, booking: updatedBooking };
      }
      await strapi.entityService.update('api::booking.booking', booking.id, {
        data: {
          status: 'failed',
          message: `Payment was not completed (Status: ${Status})`
        }
      });
      return {
        success: false,
        message: 'Payment was not completed'
      };
    } catch (error: any) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        const url = error.config?.url;
        strapi.log.error(`Zarinpal verify endpoint not found (404) at ${url}`);
        return ctx.badRequest(`Zarinpal verify endpoint not found (404) at ${url}. Please check ZARINPAL_BASE_URL environment variable.`);
      }
      strapi.log.error('Payment verification error:', error);
      return ctx.badRequest(error.message || 'Payment verification failed');
    }
  },

  /**
   * POST /bookings/free-busy
   * Proxy to Google Calendar freeBusy API using OAuth2 refresh token
   */
  async freeBusy(ctx) {
    const { timeMin, timeMax, timeZone, items } = ctx.request.body;
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REFRESH_TOKEN) {
      return ctx.badRequest('Missing Google API credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN)');
    }
    try {
      // Obtain access token via refresh token
      const tokenRes = await axios.post(
        'https://oauth2.googleapis.com/token',
        new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID!,
          client_secret: process.env.GOOGLE_CLIENT_SECRET!,
          refresh_token: process.env.GOOGLE_REFRESH_TOKEN!,
          grant_type: 'refresh_token',
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      const accessToken = tokenRes.data.access_token;
      const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
      // Call freeBusy API
      const fbResp = await axios.post(
        'https://www.googleapis.com/calendar/v3/freeBusy',
        {
          timeMin,
          timeMax,
          timeZone,
          items: items || [{ id: calendarId }],
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );
      return fbResp.data;
    } catch (err: any) {
      strapi.log.error('Google freeBusy error:', err);
      return ctx.badRequest(err.message || 'Google freeBusy API error');
    }
  },

  /**
   * POST /bookings/events
   * Proxy to Google Calendar events.insert API using OAuth2 refresh token
   */
  async createEvent(ctx) {
    // Expect bookingId and the Google event payload
    const { bookingId, event: eventBody } = ctx.request.body as any;
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REFRESH_TOKEN) {
      return ctx.badRequest('Missing Google API credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN)');
    }
    try {
      // Obtain access token via refresh token
      const tokenRes = await axios.post(
        'https://oauth2.googleapis.com/token',
        new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID!,
          client_secret: process.env.GOOGLE_CLIENT_SECRET!,
          refresh_token: process.env.GOOGLE_REFRESH_TOKEN!,
          grant_type: 'refresh_token',
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      const accessToken = tokenRes.data.access_token;
      const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
      // Create the Google Calendar event
      const evResp = await axios.post(
        `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?conferenceDataVersion=1&sendUpdates=all`,
        eventBody,
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );
      const evData = evResp.data;
      // Extract Google Meet link (hangoutLink or entryPoints)
      let meetLink: string | undefined = evData.hangoutLink;
      if (!meetLink && evData.conferenceData?.entryPoints) {
        const ep = evData.conferenceData.entryPoints.find((e: any) => e.entryPointType === 'video');
        meetLink = ep?.uri;
      }
      // Update the booking record with the meeting URL
      if (bookingId && meetLink) {
        await strapi.entityService.update('api::booking.booking', bookingId, {
          data: {
            meeting_url: meetLink,
            message: 'Meeting scheduled'
          }
        });
      }
      return evData;
    } catch (err: any) {
      strapi.log.error('Google createEvent error:', err);
      return ctx.badRequest(err.message || 'Google createEvent API error');
    }
  },

  // DEBUG override for findOne to diagnose missing records
  async findOne(ctx) {
    const { id } = ctx.params;
    strapi.log.debug(`→ booking.findOne() called with id=${id}`);
    const record = await strapi.entityService.findOne('api::booking.booking', id, {});
    strapi.log.debug('→ entityService.findOne returned:', record);
    if (!record) {
      return ctx.notFound(`No booking found for id=${id}`);
    }
    return { data: record };
  },
}));
