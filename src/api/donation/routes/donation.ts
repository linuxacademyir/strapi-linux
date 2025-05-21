/**
 * donation router
 */

/**
 * donation router
 */
export default {
  routes: [
    {
      method: 'POST',
      path: '/donations',
      handler: 'donation.create',
      config: { auth: false, policies: [], middlewares: [] },
    },
    {
      method: 'GET',
      path: '/donations/verify',
      handler: 'donation.verify',
      config: { auth: false, policies: [], middlewares: [] },
    },
    {
      method: 'GET',
      path: '/donations/:id',
      handler: 'donation.findOne',
      config: { auth: false, policies: [], middlewares: [] },
    },
  ],
};
