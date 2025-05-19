export default [
  'strapi::logger',
  'strapi::errors',
  {
    name: 'strapi::security',
    config: {
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'connect-src': ["'self'", 'http:', 'http://localhost:8080'],
          'img-src': [
            "'self'",
            'data:',
            'blob:',
            'market-assets.strapi.io',
            'http://localhost:9000', // Added local Strapi uploads domain
            'https://localhost:9000', // For HTTPS if enabled
            `${process.env.VITE_STRAPI_BASE_URL || ''}` // Dynamic URL if needed
          ],
          'media-src': [
            "'self'",
            'data:',
            'blob:',
            'market-assets.strapi.io',
            'http://localhost:9000', // Explicit protocol
            'https://localhost:9000'
          ],
          upgradeInsecureRequests: null,
        },
      },
    },
  },
  {
    name: 'strapi::cors',
    config: {
      origin: ['http://localhost:8080', 'http://localhost:9000'], // Added Strapi domain
      headers: ['Content-Type', 'Authorization', 'X-Frame-Options'],
      credentials: true,
    },
  },
  'strapi::poweredBy',
  'strapi::query',
  'strapi::body',
  'strapi::session',
  'strapi::favicon',
  'strapi::public',
];
