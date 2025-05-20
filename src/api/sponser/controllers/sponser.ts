/**
 * sponser controller
 */

import { factories } from '@strapi/strapi'

export default factories.createCoreController('api::sponser.sponser', ({ strapi }) => ({
  async find(ctx) {
    ctx.query = {
      ...ctx.query,
      filters: {
        ...((ctx.query.filters as any) || {}),
        active: true,
      },
    };
    const { data, meta } = await super.find(ctx);
    return { data, meta };
  },
  async findOne(ctx) {
    const { id } = ctx.params;
    const entities = await strapi.entityService.findMany('api::sponser.sponser', {
      filters: { id: Number(id), active: true },
      populate: ctx.query.populate,
      limit: 1,
    });
    const entity = entities[0];
    if (!entity) {
      return ctx.notFound();
    }
    return { data: entity };
  },
}));
