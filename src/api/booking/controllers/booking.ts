import { factories } from '@strapi/strapi';
import axios from 'axios';

interface ZarinpalPaymentRequest {
  merchant_id: string;
  amount: number;
  callback_url: string;
  description: string;
  metadata?: {
    booking_id?: string | number;
    note?: string;
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
  // Relation to an existing customer, or nested customer fields below
  customer?: number | string;
  name?: string;
  email?: string;
  phone?: string;
  // Booking fields
  hours: number | string;
  amount: number | string;
  price: number | string;
  note?: string;
}

export default factories.createCoreController('api::booking.booking', ({ strapi }) => ({
  async create(ctx) {
    // Validate Zarinpal configuration
    if (!process.env.ZARINPAL_MERCHANT_ID) {
      return ctx.badRequest('Missing environment variable: ZARINPAL_MERCHANT_ID');
    }
    if (!process.env.ZARINPAL_CALLBACK_URL_BOOKINGS) {
      return ctx.badRequest('Missing environment variable: ZARINPAL_CALLBACK_URL_BOOKINGS');
    }
    if (!process.env.ZARINPAL_BASE_URL) {
      return ctx.badRequest('Missing environment variable: ZARINPAL_BASE_URL');
    }
    try {
      const { data } = ctx.request.body as { data: BookingData };
      // Ensure booking fields
      if (!data.amount || !data.hours) {
        return ctx.badRequest('Missing required fields: amount and hours are required');
      }
      // Determine customer: existing relation or lookup/create
      let customerId = data.customer;
      if (!customerId) {
        if (!data.email) {
          return ctx.badRequest('Missing customer email: required to lookup or create customer');
        }
        const existingCust = await strapi.entityService.findMany('api::customer.customer', {
          filters: { email: data.email },
          limit: 1,
        });
        if (existingCust.length > 0) {
          customerId = (existingCust[0] as any).id;
        } else {
          if (!data.name || !data.phone) {
            return ctx.badRequest('Missing customer details: name and phone are required to create a new customer');
          }
          const customerPayload: any = {
            name: data.name,
            email: data.email,
            phone: data.phone,
          };
          const newCustomer = await strapi.entityService.create('api::customer.customer', {
            data: customerPayload,
          }) as any;
          customerId = newCustomer.id;
        }
      }
      // Create booking record with user relation
      const booking = await strapi.entityService.create('api::booking.booking', {
        data: {
          hours: data.hours,
          amount: data.amount,
          price: data.price,
          note: data.note,
          customer: customerId,
          bookingStatus: 'Payment initiated',
        },
      });

      // Prepare payment request
      // Build callback URL with bookingId for verification
      const callbackBase = process.env.ZARINPAL_CALLBACK_URL_BOOKINGS!.replace(/\/+$/, '');
      const callbackUrl = `${callbackBase}?bookingId=${booking.id}`;
      const paymentRequest: ZarinpalPaymentRequest = {
        merchant_id: process.env.ZARINPAL_MERCHANT_ID!,
        amount: Math.floor(Number(data.amount) * 10), // Convert to rial
        callback_url: callbackUrl,
        description: process.env.ZARINPAL_DESCRIPTION_BOOKINS!,
        metadata: { booking_id: booking.id, note: typeof data.note === 'string' ? data.note : undefined },
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
    // Extract bookingId from query params
    const bookingIdParam = ctx.query.bookingId || (ctx.query.booking_id as string | undefined);
    const bookingId = Array.isArray(bookingIdParam) ? bookingIdParam[0] : bookingIdParam;
    if (!bookingId) {
      return ctx.badRequest('Missing bookingId query parameter');
    }
    // Fetch booking to get amount and ensure existence
    const booking = await strapi.entityService.findOne('api::booking.booking', bookingId);
    if (!booking) {
      return ctx.notFound(`Booking not found for id=${bookingId}`);
    }
    // Check payment status param
    const statusParam = ctx.query.Status || (ctx.query.status as string | undefined);
    const Status = Array.isArray(statusParam) ? statusParam[0] : statusParam;
    if (Status !== 'OK') {
      await strapi.entityService.update('api::booking.booking', bookingId, { data: { bookingStatus: 'Payment Failed' } });
      return { success: false, booking };
    }
    // Validate Zarinpal config
    if (!process.env.ZARINPAL_MERCHANT_ID || !process.env.ZARINPAL_BASE_URL) {
      return ctx.badRequest('Missing Zarinpal configuration');
    }
    try {
      // Call Zarinpal verify API
      const amount = Math.floor(Number((booking as any).amount) * 10);
      const authority = Array.isArray(ctx.query.Authority)
        ? ctx.query.Authority[0]
        : (ctx.query.Authority as string) || (ctx.query.authority as string | undefined);
      if (!authority) {
        return ctx.badRequest('Missing Authority parameter');
      }
      const verifyRequest: ZarinpalVerifyRequest = {
        merchant_id: process.env.ZARINPAL_MERCHANT_ID!,
        amount,
        authority,
      };
      const baseUrl = process.env.ZARINPAL_BASE_URL!.replace(/\/+$/, '');
      const verifyResponse = await axios.post<any>(
        `${baseUrl}/pg/v4/payment/verify.json`,
        verifyRequest,
        { headers: { Accept: 'application/json', 'Content-Type': 'application/json' } }
      );
      const verifyData = verifyResponse.data.data;
      if (!verifyData) {
        throw new Error(verifyResponse.data.errors?.message || 'Verification failed');
      }
      const success = verifyData.code === 100;
      const refId = verifyData.ref_id;
      // Update booking status and transactionId
      await strapi.entityService.update('api::booking.booking', bookingId, {
        data: {
          bookingStatus: success ? 'Payment successful' : 'Payment Failed',
          transactionId: success && refId != null ? String(refId) : null,
        },
      });
      const resultBooking = await strapi.entityService.findOne('api::booking.booking', bookingId, {
        populate: ['customer'],
        locale: 'all',
      });
      return { success, booking: resultBooking };
    } catch (error: any) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        const url = error.config?.url;
        strapi.log.error(`Zarinpal verify endpoint not found (404) at ${url}`);
        return ctx.badRequest(`Zarinpal verify endpoint not found (404) at ${url}`);
      }
      strapi.log.error('Payment verification error:', error);
      return ctx.badRequest(error.message || 'Payment verification failed');
    }
  },
  async refund(ctx) {
    try {
      const { id } = ctx.params;
      const booking = await strapi.entityService.findOne('api::booking.booking', id);
      if (!booking) {
        return ctx.notFound(`Booking not found for id=${id}`);
      }
      await strapi.entityService.update('api::booking.booking', id, {
        data: { bookingStatus: 'Payment Refunded' }
      });
      const resultBooking = await strapi.entityService.findOne('api::booking.booking', id);
      return { data: resultBooking };
    } catch (error: any) {
      strapi.log.error('Booking refund error:', error);
      return ctx.badRequest(error.message || 'Refund failed');
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
    // Expect bookingId, Google event payload, and optional user data
    const { bookingId, event: eventBody } = ctx.request.body as any;
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REFRESH_TOKEN) {
      return ctx.badRequest('Missing Google API credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN)');
    }
    try {
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
      // Update the booking record with the meeting details
      if (bookingId && meetLink) {
        const isoStart = evData.start?.dateTime ?? evData.start?.date;
        const isoEnd = evData.end?.dateTime ?? evData.end?.date;
        let meetingStartDate = null;
        let meetingStartTime = null;
        if (isoStart) {
          const m = isoStart.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}:\d{2}))?/);
          if (m) {
            meetingStartDate = m[1];
            meetingStartTime = m[2] ? `${m[2]}.000` : '';
          }
        }
        let meetingEndDate = null;
        let meetingEndTime = null;
        if (isoEnd) {
          const m2 = isoEnd.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}:\d{2}))?/);
          if (m2) {
            meetingEndDate = m2[1];
            meetingEndTime = m2[2] ? `${m2[2]}.000` : '';
          }
        }
        const updateData: any = {
          meetingUrl: meetLink,
          bookingStatus: 'Meeting scheduled',
          meetingStartDate,
          meetingStartTime,
          meetingEndDate,
          meetingEndTime,
        };
        await strapi.entityService.update('api::booking.booking', bookingId, {
          data: updateData,
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
