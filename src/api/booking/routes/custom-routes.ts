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
      }
    ]
  };
  