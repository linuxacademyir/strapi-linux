/**
 * donation controller
 */

import { factories } from '@strapi/strapi'

import axios from 'axios';

export default factories.createCoreController('api::donation.donation', ({ strapi }) => ({
  async create(ctx) {
    const { amount, name, email, mobile } = ctx.request.body;
    const merchantId = process.env.ZARINPAL_MERCHANT_ID;
    const description = process.env.ZARINPAL_DESCRIPTION_DONATION;
    try {
      const donation = await strapi.entityService.create('api::donation.donation', {
        data: { amount, name, email, mobile, donationStatus: 'Payment initiated' },
      });
      const callbackURL = `${process.env.ZARINPAL_CALLBACK_URL_DONATIONS}?donationId=${donation.id}`;
      const payload = {
        merchant_id: merchantId,
        amount,
        callback_url: callbackURL,
        description,
        metadata: { email, mobile },
      };
      const response = await axios.post(
        `${process.env.ZARINPAL_BASE_URL}/pg/v4/payment/request.json`,
        payload,
        { headers: { 'Content-Type': 'application/json' } }
      );
      const data = response.data.data;
      if (data.code === 100) {
        return {
          paymentUrl: `${process.env.ZARINPAL_BASE_URL}/pg/StartPay/${data.authority}`,
          orderId: donation.id,
        };
      }
      ctx.throw(400, `Zarinpal error: ${data.code}`);
    } catch (err) {
      ctx.throw(500, err);
    }
  },

  async verify(ctx) {
    const { donationId, Authority, Status } = ctx.query;
    if (Status !== 'OK') ctx.throw(400, 'Payment was not successful');
    if (!donationId) ctx.throw(400, 'Donation ID is required');
    const id = parseInt(donationId as string, 10);
    const existing = await strapi.entityService.findOne('api::donation.donation', id, {});
    if (!existing) ctx.throw(404, 'Donation not found');
    try {
      const merchantId = process.env.ZARINPAL_MERCHANT_ID;
      const verifyPayload = { merchant_id: merchantId, authority: Authority, amount: existing.amount };
      const response = await axios.post(
        `${process.env.ZARINPAL_BASE_URL}/pg/v4/payment/verify.json`,
        verifyPayload,
        { headers: { 'Content-Type': 'application/json' } }
      );
      const data = response.data.data;
      if (data.code === 100) {
        const updated = await strapi.entityService.update('api::donation.donation', id, {
          data: { donationStatus: 'Payment successful', transactionId: String(data.ref_id) },
        });
        ctx.body = { success: true, data: updated };
      } else {
        await strapi.entityService.update('api::donation.donation', id, { data: { donationStatus: 'Payment Failed' } });
        ctx.throw(400, `Verification error: ${data.code}`);
      }
    } catch (err) {
      ctx.throw(500, err);
    }
  },

  // Override default findOne to return data without throwing 404
  async findOne(ctx) {
    const { id } = ctx.params;
    const record = await strapi.entityService.findOne('api::donation.donation', id, {});
    return { data: record };
  }
}));
