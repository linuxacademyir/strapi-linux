import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::booking.booking', {
  config: {
    create: {
      auth: false, // Make public if needed
      policies: [],
      middlewares: [],
    },
    verify: {
      auth: false,
      policies: [],
      middlewares: [],
    }
  },
  only: ['create', 'verify'],
  except: [],
  prefix: '',
});
