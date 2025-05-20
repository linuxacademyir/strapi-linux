// Custom order routes: payment verify
export default {
  routes: [
    {
      method: 'GET',
      path: '/orders/verify',
      handler: 'order.verify',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/orders/:id/refund',
      handler: 'order.refund',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};