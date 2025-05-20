import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::booking.booking', {
  config: {
    create: { auth: false, policies: [], middlewares: [] },
    findOne: { auth: false, policies: [], middlewares: [] },
  },
  only: ['create', 'findOne'],
});
