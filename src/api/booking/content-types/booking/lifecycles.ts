export default {
  async beforeUpdate(event) {
    const { params } = event;
    const { where, data } = params;
    const id = where?.id ?? params.id;
    const existing: any = await strapi.entityService.findOne('api::booking.booking', id);
    if (data && data.bookingStatus !== undefined) {
      const oldStatus = existing.bookingStatus;
      const newStatus = data.bookingStatus;
      if (oldStatus === newStatus) {
        return;
      }
      // allow payment transitions
      if (
        oldStatus === 'Payment initiated' &&
        (newStatus === 'Payment successful' || newStatus === 'Payment Failed')
      ) {
        return;
      }
      // allow refund and scheduling transitions from Payment successful
      if (
        oldStatus === 'Payment successful' &&
        (newStatus === 'Payment Refunded' || newStatus === 'Meeting scheduled')
      ) {
        return;
      }
      // allow refund transition from Meeting scheduled
      if (oldStatus === 'Meeting scheduled' && newStatus === 'Payment Refunded') {
        // Set a flag to indicate that the status is changing to Payment Refunded
        event.state.isTransitioningToRefunded = true;
        return;
      }
      throw new Error(
        'Invalid status transition: only Payment initiated→(Payment successful|Payment Failed), Payment successful→(Payment Refunded|Meeting scheduled), or Meeting scheduled→Payment Refunded are allowed'
      );
    }
  },
  async afterUpdate(event) {
    const { result, state } = event;
    // Check if the bookingStatus was just updated to 'Payment Refunded'
    if (state && state.isTransitioningToRefunded) {
      const bookingId = result.id;
      try {
        // Fetch the updated booking to ensure eventId is populated
        const updatedBooking = await strapi.entityService.findOne('api::booking.booking', bookingId, {
          fields: ['eventId'],
        });

        // If an eventId exists, attempt to delete the Google Calendar event
        if (updatedBooking && updatedBooking.eventId) {
          try {
            // Obtain Google access token (similar to the controller)
            const axios = require('axios'); // Require axios here as it's not imported by default in lifecycles
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
            const eventIdToDelete = updatedBooking.eventId;

            // Delete the Google Calendar event
            await axios.delete(
              `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${eventIdToDelete}`,
              {
                headers: {
                  'Authorization': `Bearer ${accessToken}`,
                },
              }
            );
            strapi.log.info(`Successfully deleted Google Calendar event ${eventIdToDelete} from calendar ${calendarId} for booking ${bookingId} via lifecycle hook`);
          } catch (googleError: any) {
            strapi.log.error(`Failed to delete Google Calendar event for booking ${bookingId} via lifecycle hook:`, googleError);
          }

          // Clear meeting-related fields from the booking record
          await strapi.entityService.update('api::booking.booking', bookingId, {
            data: {
              meetingUrl: null,
              meetingStartDate: null,
              meetingEndDate: null,
              meetingStartTime: null,
              meetingEndTime: null,
              googleConferenceId: null,
            },
          });
          strapi.log.info(`Cleared meeting details for booking ${bookingId} after refund.`);
        }
      } catch (error: any) {
        strapi.log.error(`Error in afterUpdate lifecycle hook for booking ${bookingId}:`, error);
      }
    }
  },
};
