import { factories } from '@strapi/strapi';
import axios from 'axios';

interface ZarinpalPaymentRequest {
  merchant_id: string;
  amount: number;
  callback_url: string;
  description: string;
  metadata?: {
    order_id?: string | number;
    package_id?: string | number;
  };
}

interface ZarinpalVerifyRequest {
  merchant_id: string;
  amount: number;
  authority: string;
}

interface ZarinpalResponse<T> {
  data: T;
  errors?: {
    message: string;
    [key: string]: any;
  };
}

interface OrderData {
  price?: string;
  quantity?: string;
  amount: string;
  note?: string;
  internalNote?: string;
  package: number;
  sponser?: number;
  name?: string;
  email?: string;
  phone?: string;
  companyName?: string;
  companyWebsite?: string;
  instagramId?: string;
  companyLogo?: number;
  couponCode?: string;
}

export default factories.createCoreController('api::order.order', ({ strapi }) => ({
  async create(ctx) {
    // Load Zarinpal config from global
    const globalConfig = await strapi.entityService.findOne('api::global.global', 1, { fields: ['ZarinpalMerchantId', 'ZarinpalBaseUrl'] });
    const merchantId = globalConfig?.ZarinpalMerchantId || process.env.ZARINPAL_MERCHANT_ID;
    const baseUrl = (globalConfig?.ZarinpalBaseUrl || process.env.ZARINPAL_BASE_URL)?.replace(/\/+$/, '');
    if (!merchantId) {
      return ctx.badRequest('Missing Zarinpal merchant ID (set in global or env)');
    }
    const callbackUrlOrders = process.env.ZARINPAL_CALLBACK_URL_ORDERS ?? process.env.ZARINPAL_CALLBACK_URL;
    if (!callbackUrlOrders) {
      return ctx.badRequest('Missing environment variable: ZARINPAL_CALLBACK_URL_ORDERS or ZARINPAL_CALLBACK_URL');
    }
    if (!baseUrl) {
      return ctx.badRequest('Missing Zarinpal base URL (set in global or env)');
    }
    try {
      const { data } = ctx.request.body as { data: OrderData };

      // Ensure required fields for creating an order
      if (!data.amount || !data.package) {
        return ctx.badRequest('Missing required fields: amount and package are required');
      }
      // Determine sponsor: use existing relation, lookup by email, or create new
      let sponserId = data.sponser;
      if (!sponserId) {
        if (!data.email) {
          return ctx.badRequest('Missing sponsor email: cannot lookup or create sponsor without email');
        }
        const existing = await strapi.entityService.findMany('api::sponser.sponser', {
          filters: { email: data.email },
          limit: 1,
        });
        if (existing.length > 0) {
          sponserId = (existing[0] as any).id;
        } else {
          if (!data.name || !data.phone) {
            return ctx.badRequest('Missing sponsor details: name and phone are required to create a new sponsor');
          }
          const sponsorPayload: any = {
            name: data.name,
            email: data.email,
            phone: data.phone,
          };
          if (data.companyName) sponsorPayload.companyName = data.companyName;
          if (data.companyWebsite) sponsorPayload.companyWebsite = data.companyWebsite;
          if (data.instagramId) sponsorPayload.instagramId = data.instagramId;
          if (data.companyLogo) sponsorPayload.companyLogo = data.companyLogo;
          if (data.note) sponsorPayload.note = data.note;
          if (data.internalNote) sponsorPayload.internalNote = data.internalNote;
          const newSponsor = await strapi.entityService.create('api::sponser.sponser', {
            data: sponsorPayload,
          }) as any;
          sponserId = newSponsor.id;
        }
      }

      // Coupon logic
      let discount = 0;
      let couponId = null;
      if (data.couponCode) {
        const coupons = await strapi.entityService.findMany('api::coupon.coupon', {
          filters: { code: data.couponCode, isActive: true, applicableTo: 'orders' },
          limit: 1,
        });
        if (!coupons.length) return ctx.badRequest('Invalid or inactive coupon');
        const c = coupons[0];
        // Validate date
        const now = new Date();
        if (c.startDate && new Date(c.startDate) > now) return ctx.badRequest('Coupon not started yet');
        if (c.endDate && new Date(c.endDate) < now) return ctx.badRequest('Coupon expired');
        if (c.usageLimit && c.usedCount && c.usedCount >= c.usageLimit) return ctx.badRequest('Coupon usage limit reached');
        if (c.minOrderAmount && Number(data.amount) < c.minOrderAmount) return ctx.badRequest('Order amount below coupon minimum');
        // Calculate discount
        if (c.type === 'percentage') {
          discount = Number(data.amount) * Number(c.value) / 100;
        } else if (c.type === 'fixed') {
          discount = Number(c.value);
        }
        couponId = c.id;
      }

      const finalAmount = Math.max(0, Number(data.amount) - discount);
      const order = await strapi.entityService.create('api::order.order', {
        data: {
          package: data.package,
          amount: String(finalAmount),
          price: data.price,
          quantity: data.quantity,
          note: data.note,
          internalNote: data.internalNote,
          sponser: sponserId,
          orderStatus: 'Payment initiated',
          coupon: couponId,
        },
      });
      // sponsor relation provided via data.sponser in request

      // Prepare payment request with callback including orderId
      const callbackBase = callbackUrlOrders!.replace(/\/+$/, '');
      const callbackUrl = `${callbackBase}?orderId=${order.id}`;
      const paymentRequest: ZarinpalPaymentRequest = {
        merchant_id: merchantId,
        amount: Math.floor(Number(finalAmount) * 10),
        callback_url: callbackUrl,
        description: process.env.ZARINPAL_DESCRIPTION_ORDERS!,
        metadata: {
          order_id: String(order.id),
          package_id: String(data.package),
        },
      };

      const paymentResponse = await axios.post<any>(
        `${baseUrl}/pg/v4/payment/request.json`,
        paymentRequest,
        {
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
        }
      );
      const paymentData = paymentResponse.data.data;
      const paymentError = paymentResponse.data.errors;
      if (!paymentData || paymentData.code !== 100) {
        const errMsg = paymentError?.message || 'Payment initiation failed';
        throw new Error(errMsg);
      }
      const authority = paymentData.authority as string; // used for redirect only
      const isSandbox = baseUrl.includes('sandbox');
      const redirectBase = isSandbox ? 'https://sandbox.zarinpal.com' : 'https://www.zarinpal.com';
      return {
        paymentUrl: `${redirectBase}/pg/StartPay/${authority}`,
        orderId: order.id,
      };
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        const { response, config } = error;
        if (response) {
          if (response.status === 404) {
            const url = config?.url;
            strapi.log.error(`Zarinpal endpoint not found (404) at ${url}`);
            return ctx.badRequest(`Zarinpal endpoint not found (404) at ${url}. Please check ZARINPAL_BASE_URL_ORDERS environment variable.`);
          }
          const errMsg =
            response.data?.errors?.message ||
            response.data?.error?.message ||
            response.data?.message ||
            `Unexpected status code ${response.status}`;
          strapi.log.error(`Zarinpal request failed at ${config?.url}:`, response.data);
          return ctx.badRequest(`Zarinpal error: ${errMsg}`);
        }
        return ctx.badRequest(error.message || 'Payment request failed');
      }
      strapi.log.error('Order creation error:', error);
      return ctx.badRequest(error.message || 'Order creation failed');
    }
  },

  async verify(ctx) {
    // Extract orderId from query params
    const orderIdParam = ctx.query.orderId || (ctx.query.order_id as string | undefined);
    const orderId = Array.isArray(orderIdParam) ? orderIdParam[0] : orderIdParam;
    if (!orderId) {
      return ctx.badRequest('Missing orderId query parameter');
    }
    // Fetch existing order
    const order = await strapi.entityService.findOne('api::order.order', orderId, { populate: ['coupon'] }) as any;
    if (!order) {
      return ctx.notFound(`Order not found for id=${orderId}`);
    }
    // Check payment status param
    const statusParam = ctx.query.Status || (ctx.query.status as string | undefined);
    const Status = Array.isArray(statusParam) ? statusParam[0] : statusParam;
    if (Status !== 'OK') {
      await strapi.entityService.update('api::order.order', orderId, { data: { orderStatus: 'Payment Failed' } });
      return { success: false, order };
    }
    // Load Zarinpal config from global
    const globalConfig = await strapi.entityService.findOne('api::global.global', 1, { fields: ['ZarinpalMerchantId', 'ZarinpalBaseUrl'] });
    const merchantId = globalConfig?.ZarinpalMerchantId || process.env.ZARINPAL_MERCHANT_ID;
    const baseUrl = (globalConfig?.ZarinpalBaseUrl || process.env.ZARINPAL_BASE_URL)?.replace(/\/+$/, '');
    if (!merchantId || !baseUrl) {
      return ctx.badRequest('Missing Zarinpal configuration (set in global or env)');
    }
    try {
      // Extract authority param
      const authorityParam = ctx.query.Authority || (ctx.query.authority as string | undefined);
      const authority = Array.isArray(authorityParam) ? authorityParam[0] : authorityParam;
      if (!authority) {
        return ctx.badRequest('Missing Authority parameter');
      }
      // Call Zarinpal verify API
      const verifyRequest: ZarinpalVerifyRequest = {
        merchant_id: merchantId,
        amount: Math.floor(Number((order as any).amount) * 10),
        authority,
      };
      const verifyResponse = await axios.post<any>(
        `${baseUrl}/pg/v4/payment/verify.json`,
        verifyRequest,
        { headers: { Accept: 'application/json', 'Content-Type': 'application/json' } }
      );
      const verifyData = verifyResponse.data.data;
      if (!verifyData) {
        throw new Error(verifyResponse.data.errors?.message || 'Verification failed');
      }
      const success = verifyData.code === 100;
      const refId = verifyData.ref_id;
      // Update order status and transactionId
      await strapi.entityService.update('api::order.order', orderId, {
        data: {
          orderStatus: success ? 'Payment successful' : 'Payment Failed',
          transactionId: success && refId != null ? String(refId) : null,
        },
      });
      // Increment coupon usage if applicable
      if (success && order.coupon && order.coupon.id) {
        await strapi.entityService.update('api::coupon.coupon', order.coupon.id, {
          data: { usedCount: (order.coupon.usedCount || 0) + 1 },
        });
      }
      // Re-fetch the updated order
      const resultOrder = await strapi.entityService.findOne('api::order.order', orderId, {
        populate: ['package', 'sponser'],
        locale: 'all',
      });
      return { success, order: resultOrder };
    } catch (error: any) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        const url = error.config?.url;
        strapi.log.error(`Zarinpal verify endpoint not found (404) at ${url}`);
        return ctx.badRequest(`Zarinpal verify endpoint not found (404) at ${url}`);
      }
      strapi.log.error('Payment verification error:', error);
      return ctx.badRequest(error.message || 'Payment verification failed');
    }
  },
  async refund(ctx) {
    try {
      const { id } = ctx.params;
      const order = await strapi.entityService.findOne('api::order.order', id);
      if (!order) {
        return ctx.notFound(`Order not found for id=${id}`);
      }
      await strapi.entityService.update('api::order.order', id, {
        data: { orderStatus: 'Payment Refunded' },
      });
      const resultOrder = await strapi.entityService.findOne('api::order.order', id, {
        populate: ['package', 'sponser'],
        locale: 'all',
      });
      return { data: resultOrder };
    } catch (error: any) {
      strapi.log.error('Order refund error:', error);
      return ctx.badRequest(error.message || 'Refund failed');
    }
  },
  async findOne(ctx) {
    const { id } = ctx.params;
    const record = await strapi.entityService.findOne('api::order.order', id, {
      populate: ['package', 'sponser'],
      locale: 'all',
    });
    if (!record) {
      return ctx.notFound(`No order found for id=${id}`);
    }
    return { data: record };
  },
}));