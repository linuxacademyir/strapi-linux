import { factories } from '@strapi/strapi';
import axios from 'axios';
const { DateTime } = require('luxon');

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

interface BookingWithCoupon {
  coupon?: { id: number; usedCount?: number };
  // Add other fields as needed
}

export default factories.createCoreController('api::booking.booking', ({ strapi }) => ({
  async create(ctx) {
    // Load Zarinpal config from global
    const globalConfig = await strapi.entityService.findOne('api::global.global', 1, { fields: ['ZarinpalMerchantId', 'ZarinpalBaseUrl'] });
    const merchantId = globalConfig?.ZarinpalMerchantId || process.env.ZARINPAL_MERCHANT_ID;
    const baseUrl = (globalConfig?.ZarinpalBaseUrl || process.env.ZARINPAL_BASE_URL)?.replace(/\/+$/, '');
    if (!merchantId) {
      return ctx.badRequest('Missing Zarinpal merchant ID (set in global or env)');
    }
    if (!process.env.ZARINPAL_CALLBACK_URL_BOOKINGS) {
      return ctx.badRequest('Missing environment variable: ZARINPAL_CALLBACK_URL_BOOKINGS');
    }
    if (!baseUrl) {
      return ctx.badRequest('Missing Zarinpal base URL (set in global or env)');
    }
    try {
      const { data } = ctx.request.body as { data: BookingData & { couponCode?: string } };
      // Ensure booking fields
      if (!data.amount || !data.hours) {
        return ctx.badRequest('Missing required fields: amount and hours are required');
      }
      // Coupon logic
      let discount = 0;
      let couponId = null;
      if (data.couponCode) {
        const coupons = await strapi.entityService.findMany('api::coupon.coupon', {
          filters: { code: data.couponCode, isActive: true, applicableTo: 'bookings' },
          limit: 1,
        });
        if (!coupons.length) return ctx.badRequest('Invalid or inactive coupon');
        const c = coupons[0];
        // Validate date
        const now = new Date();
        if (c.startDate && new Date(c.startDate) > now) return ctx.badRequest('Coupon not started yet');
        if (c.endDate && new Date(c.endDate) < now) return ctx.badRequest('Coupon expired');
        if (c.usageLimit && c.usedCount && c.usedCount >= c.usageLimit) return ctx.badRequest('Coupon usage limit reached');
        if (c.minOrderAmount && Number(data.amount) < c.minOrderAmount) return ctx.badRequest('Order amount below coupon minimum');
        // Calculate discount
        if (c.type === 'percentage') {
          discount = Number(data.amount) * Number(c.value) / 100;
        } else if (c.type === 'fixed') {
          discount = Number(c.value);
        }
        couponId = c.id;
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
      // Create booking record with user relation and coupon
      const finalAmount = Math.max(0, Number(data.amount) - discount);
      const booking = await strapi.entityService.create('api::booking.booking', {
        data: {
          hours: data.hours,
          amount: finalAmount,
          price: data.price,
          note: data.note,
          customer: customerId,
          bookingStatus: 'Payment initiated',
          coupon: couponId,
        },
      });

      // Prepare payment request
      // Build callback URL with bookingId for verification
      const callbackBase = process.env.ZARINPAL_CALLBACK_URL_BOOKINGS!.replace(/\/+$/, '');
      const callbackUrl = `${callbackBase}?bookingId=${booking.id}`;
      const paymentRequest: ZarinpalPaymentRequest = {
        merchant_id: merchantId,
        amount: Math.floor(Number(finalAmount) * 10), // Convert to rial
        callback_url: callbackUrl,
        description: process.env.ZARINPAL_DESCRIPTION_BOOKINS!,
        metadata: { booking_id: booking.id, note: typeof data.note === 'string' ? data.note : undefined },
      };

      // Call Zarinpal API
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
    const booking = await strapi.entityService.findOne('api::booking.booking', bookingId, { populate: ['coupon'] }) as any;
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
    // Load Zarinpal config from global
    const globalConfig = await strapi.entityService.findOne('api::global.global', 1, { fields: ['ZarinpalMerchantId', 'ZarinpalBaseUrl'] });
    const merchantId = globalConfig?.ZarinpalMerchantId || process.env.ZARINPAL_MERCHANT_ID;
    const baseUrl = (globalConfig?.ZarinpalBaseUrl || process.env.ZARINPAL_BASE_URL)?.replace(/\/+$/, '');
    if (!merchantId || !baseUrl) {
      return ctx.badRequest('Missing Zarinpal configuration (set in global or env)');
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
        merchant_id: merchantId,
        amount,
        authority,
      };
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
      // Increment coupon usage if applicable
      if (success && booking.coupon && booking.coupon.id) {
        await strapi.entityService.update('api::coupon.coupon', booking.coupon.id, {
          data: { usedCount: (booking.coupon.usedCount || 0) + 1 },
        });
      }
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
      const updatedBooking = await strapi.entityService.findOne('api::booking.booking', id, {
        fields: ['eventId'], // Ensure eventId is populated
      });

      // If a eventId exists, attempt to delete the Google Calendar event
      if (updatedBooking && updatedBooking.eventId) {
        try {
          // Obtain Google access token
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

          // Get primary calendar ID from global settings
          const settings = await strapi.entityService.findOne('api::global.global', 1, {
            fields: ['primaryCalendarId'],
          });
          const calendarId = settings?.primaryCalendarId || process.env.GOOGLE_CALENDAR_ID || 'primary';
          const eventId = updatedBooking.eventId; // Use eventId

          // Delete the Google Calendar event
          strapi.log.info(`Attempting to delete Google Calendar event ${eventId} from calendar ${calendarId}`);
          await axios.delete(
            `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${eventId}`,
            {
              headers: {
                'Authorization': `Bearer ${accessToken}`,
              },
            }
          );
          strapi.log.info(`Successfully deleted Google Calendar event ${eventId} from calendar ${calendarId} for booking ${id}`);
        } catch (googleError: any) {
          strapi.log.error(`Failed to delete Google Calendar event for booking ${id}:`, googleError);
          // Continue with refund process even if calendar event deletion fails
        }
      }

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
      let { timeMin, timeMax, timeZone, date } = ctx.request.body;

      // If only date is provided, or timeZone is missing, load from global
      const globalSettings = await strapi.entityService.findOne('api::global.global', 1, { fields: ['CalendarTimeZone'] });
      if (!timeZone) {
        timeZone = globalSettings?.CalendarTimeZone || 'Asia/Tehran';
      }
      if (date && (!timeMin || !timeMax)) {
        // Use Luxon to get correct ISO with offset
        const dayStart = DateTime.fromISO(date, { zone: timeZone }).startOf('day');
        const dayEnd = DateTime.fromISO(date, { zone: timeZone }).endOf('day');
        timeMin = dayStart.toISO(); // e.g. 2025-05-29T00:00:00.000+03:30
        timeMax = dayEnd.toISO();   // e.g. 2025-05-29T23:59:59.999+03:30
      }

      const iso8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/;
      if (!timeMin || !timeMax || !iso8601.test(timeMin) || !iso8601.test(timeMax)) {
        return ctx.badRequest('Invalid timeMin or timeMax format. Expected ISO 8601 format.');
      }

      if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REFRESH_TOKEN) {
        return ctx.badRequest('Missing Google API credentials');
      }

      try {
        // Get Google access token
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

        // Get calendar IDs
        const settings = await strapi.entityService.findOne('api::global.global', 1, {
          fields: ['primaryCalendarId', 'secondCalendar', 'thirdCalendar', 'forthCalendar'],
        });

        const calendarIds = [
          settings.primaryCalendarId,
          settings.secondCalendar,
          settings.thirdCalendar,
          settings.forthCalendar,
        ].filter((id): id is string => Boolean(id));

        const itemsToFetch = calendarIds.length > 0
          ? calendarIds.map(id => ({ id }))
          : [{ id: process.env.GOOGLE_CALENDAR_ID || 'primary' }];

        // Query Google FreeBusy
        strapi.log.info('Google freeBusy payload:', {
          timeMin,
          timeMax,
          timeZone,
          items: itemsToFetch
        });
        const fbResp = await axios.post(
          'https://www.googleapis.com/calendar/v3/freeBusy',
          { timeMin, timeMax, timeZone, items: itemsToFetch },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${accessToken}`,
            },
          }
        );

        const calendarsMap = fbResp.data.calendars || {};
        const busyEvents = Object.entries(calendarsMap).flatMap(([calendarId, cal]: [string, any]) =>
          Array.isArray(cal.busy)
            ? cal.busy.map(b => ({ start: b.start, end: b.end, calendarId }))
            : []
        );

        // Convert busy times to ms intervals for conflict checks
        const busyIntervals = busyEvents.map(be => ({
          start: new Date(be.start).getTime(),
          end: new Date(be.end).getTime(),
          calendarId: be.calendarId,
        }));

        // Format date/time in timezone WITHOUT offset suffix
        const formatDateTimeWithoutOffset = (date: Date, tz: string): string => {
          const formatter = new Intl.DateTimeFormat(undefined, {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23',
          });

          const parts = formatter.formatToParts(date);
          const dp: Record<string, string> = {};
          for (const part of parts) {
            if (['year', 'month', 'day', 'hour', 'minute', 'second'].includes(part.type)) {
              dp[part.type] = part.value;
            }
          }
          return `${dp.year}-${dp.month}-${dp.day}T${dp.hour}:${dp.minute}:${dp.second}`;
        };

        // Build busySlots for the whole day (from timeMin to timeMax, 1-hour slots)
        const busySlots: Array<{ start: string; end: string; calendarIds: string[] }> = [];
        const freeSlots: Array<{ start: string; end: string }> = [];

        // Build all 1-hour slots for the whole requested range
        const startBoundaryMs = new Date(timeMin).getTime();
        const endBoundaryMs = new Date(timeMax).getTime();
        const HOUR = 60 * 60 * 1000;
        for (let slotStart = startBoundaryMs; slotStart + HOUR <= endBoundaryMs; slotStart += HOUR) {
          const slotEnd = slotStart + HOUR;
          // Check for any overlap with busy intervals
          const overlapping = busyIntervals.filter(
            ({ start, end }) => start < slotEnd && end > slotStart
          );
          if (overlapping.length > 0) {
            const calendarIds = Array.from(new Set(overlapping.map(b => b.calendarId)));
            busySlots.push({
              start: formatDateTimeWithoutOffset(new Date(slotStart), timeZone),
              end: formatDateTimeWithoutOffset(new Date(slotEnd), timeZone),
              calendarIds,
            });
          }
        }

        // Free slots: only those within available hours and not busy
        // Fetch available hours from Strapi
        const allAvails = await strapi.entityService.findMany('api::available-hour.available-hour', {});
        const windowsByDay: { [key: string]: Array<{ startTime: string; endTime: string; dayOff?: boolean }> } = {};
        const dayOffByDay: { [key: string]: boolean } = {};
        for (const avail of allAvails) {
          if (avail.day) {
            const dayOfWeek = avail.day.toLowerCase();
            if (!windowsByDay[dayOfWeek]) {
              windowsByDay[dayOfWeek] = [];
            }
            windowsByDay[dayOfWeek].push({ startTime: avail.timeMin as string, endTime: avail.timeMax as string, dayOff: (avail as any).dayOff });
            if ((avail as any).dayOff) {
              dayOffByDay[dayOfWeek] = true;
            }
          }
        }
        const weekdayFormatter = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone });
        let current = new Date(timeMin);
        const end = new Date(timeMax);
        while (current < end) {
          const localWeekday = weekdayFormatter.format(current).toLowerCase();
          // If dayOff is set for this day, skip free slots
          if (dayOffByDay[localWeekday]) {
            current.setUTCDate(current.getUTCDate() + 1);
            current.setUTCHours(0, 0, 0, 0);
            continue;
          }
          const windows = windowsByDay[localWeekday] || [];
          for (const window of windows) {
            const [startHour, startMinute] = window.startTime.split(':').map(Number);
            const [endHour, endMinute] = window.endTime.split(':').map(Number);
            const windowStart = new Date(current);
            windowStart.setHours(startHour, startMinute, 0, 0);
            const windowEnd = new Date(current);
            windowEnd.setHours(endHour, endMinute, 0, 0);
            let slotStart = windowStart.getTime();
            if (new Date(slotStart).getMinutes() !== 0 || new Date(slotStart).getSeconds() !== 0 || new Date(slotStart).getMilliseconds() !== 0) {
              const d = new Date(slotStart);
              d.setMinutes(0, 0, 0);
              d.setHours(d.getHours() + 1);
              slotStart = d.getTime();
            }
            while (slotStart + HOUR <= windowEnd.getTime() && slotStart + HOUR <= end.getTime()) {
              const slotEnd = slotStart + HOUR;
              // Check for any overlap with busy intervals
              const overlapping = busyIntervals.filter(
                ({ start, end }) => start < slotEnd && end > slotStart
              );
              if (overlapping.length === 0) {
                freeSlots.push({
                  start: formatDateTimeWithoutOffset(new Date(slotStart), timeZone),
                  end: formatDateTimeWithoutOffset(new Date(slotEnd), timeZone),
                });
              }
              slotStart += HOUR;
            }
          }
          current.setUTCDate(current.getUTCDate() + 1);
          current.setUTCHours(0, 0, 0, 0);
        }

        // Deduplicate slots by start and end
        function dedupeSlots(slots) {
          const seen = new Set();
          return slots.filter(slot => {
            const key = `${slot.start}|${slot.end}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }

        return {
          busySlots: dedupeSlots(busySlots),
          freeSlots: dedupeSlots(freeSlots),
        };
      } catch (err: any) {
        if (err.response) {
          strapi.log.error('Google freeBusy error:', err.response.data);
          return ctx.badRequest(JSON.stringify(err.response.data));
        }
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
          eventId: evData.id,
          googleConferenceId: evData.conferenceData?.conferenceId,
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
