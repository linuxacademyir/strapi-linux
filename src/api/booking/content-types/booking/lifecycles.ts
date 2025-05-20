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
        return;
      }
      throw new Error(
        'Invalid status transition: only Payment initiated→(Payment successful|Payment Failed), Payment successful→(Payment Refunded|Meeting scheduled), or Meeting scheduled→Payment Refunded are allowed'
      );
    }
  },
};