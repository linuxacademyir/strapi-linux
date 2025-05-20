// Custom booking routes: schedule, free-busy, payment verify
export default {
  routes: [
    {
      method: 'GET',
      path: '/bookings/verify',
      handler: 'booking.verify',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/bookings/free-busy',
      handler: 'booking.freeBusy',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/bookings/events',
      handler: 'booking.createEvent',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/bookings/:id/refund',
      handler: 'booking.refund',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};