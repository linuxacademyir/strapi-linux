
export default {
  async beforeUpdate(event) {
    const { params } = event;
    const { where, data } = params;
    const id = where?.id ?? params.id;
    const existing: any = await strapi.entityService.findOne('api::order.order', id);
    if (data && data.orderStatus !== undefined) {
      const oldStatus = existing.orderStatus;
      const newStatus = data.orderStatus;
      if (oldStatus === newStatus) {
        return;
      }
      // allow verification transitions
      if (oldStatus === 'Payment initiated' && (newStatus === 'Payment successful' || newStatus === 'Payment Failed')) {
        return;
      }
      // allow refund transition
      if (oldStatus === 'Payment successful' && newStatus === 'Payment Refunded') {
        return;
      }
      throw new Error(
        'Invalid status transition: only Payment initiated→(Payment successful|Payment Failed) or Payment successful→Payment Refunded are allowed'
      );
    }
  },
};