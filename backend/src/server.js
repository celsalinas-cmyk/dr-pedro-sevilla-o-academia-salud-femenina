import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import { db } from './db/pool.js';
import { CheckoutService } from './services/checkout.service.js';

export async function buildApp(customDb = db, opts = {}) {
  // Determine trusted proxies: false by default in local/dev; or explicit list of proxy IPs in production
  const trustProxy = opts.trustProxy !== undefined 
    ? opts.trustProxy 
    : (config.nodeEnv === 'production' && process.env.TRUSTED_PROXIES ? process.env.TRUSTED_PROXIES.split(',') : false);

  const app = Fastify({
    logger: config.nodeEnv === 'development' ? {
      level: 'info',
      serializers: {
        req(req) {
          // Zero PII and token sanitization for incoming requests
          // Never log raw token paths, query strings, or sentinels
          // Cleanly extract route template without query params
          const pathOnly = (req.url || '').split('?')[0];
          const sanitizedRoute = pathOnly.replace(/\/orders\/[^\/]+\/status/i, '/orders/:opaque_token/status');
          return {
            method: req.method,
            route: sanitizedRoute,
            remoteAddress: req.ip,
          };
        },
        res(res) {
          return {
            statusCode: res.statusCode,
          };
        }
      }
    } : false,
    trustProxy,
  });

  // Abuse Protection & Rate Limiting (P1)
  // Use client IP as resolved by Fastify (respecting trustProxy setting)
  await app.register(rateLimit, {
    max: opts.rateLimitMax || 30, // 30 requests per minute by default
    timeWindow: '1 minute',
    keyGenerator: (req) => {
      // If trustProxy is disabled, req.raw.socket.remoteAddress is strictly used
      return req.ip || req.raw.socket.remoteAddress;
    },
    errorResponseBuilder: (request, context) => ({
      error: 'TOO_MANY_REQUESTS',
      message: `Rate limit exceeded. Try again in ${Math.ceil(context.after / 1000)} seconds.`,
      statusCode: 429
    })
  });

  // CORS Configuration
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (config.allowedOrigins.includes(origin)) {
        return cb(null, true);
      }
      return cb(new Error('Not allowed by CORS'), false);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: true,
  });

  // Global Error Handler for Controlled, Sanitized Responses
  app.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode || 500;
    
    // Log sanitized error internally without exposing SQL or stack trace to client
    request.log.error({
      errCode: error.code,
      message: statusCode >= 500 ? 'Internal error' : error.message,
      statusCode,
    }, 'Handled application error');

    if (statusCode === 429) {
      return reply.code(429).send({
        error: 'TOO_MANY_REQUESTS',
        message: error.message || 'Rate limit exceeded.',
      });
    }

    if (statusCode >= 500) {
      return reply.code(500).send({
        error: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected internal error occurred. Please contact support.',
      });
    }

    return reply.code(statusCode).send({
      error: error.code || 'BAD_REQUEST',
      message: error.message,
    });
  });

  const checkoutService = new CheckoutService(customDb, config.defaultAcademyId);

  // Health check endpoint
  app.get('/health', async () => {
    return { status: 'healthy', academy: config.defaultAcademyId };
  });

  // POST /api/v1/checkout
  app.post('/api/v1/checkout', async (request, reply) => {
    const clientIp = request.ip;
    const userAgent = request.headers['user-agent'] || '';
    
    const result = await checkoutService.processCheckout(request.body || {}, clientIp, userAgent);
    return reply.code(result.statusCode).send(result.order);
  });

  // GET /api/v1/orders/:opaque_token/status (Zero PII, Sanitized path)
  app.get('/api/v1/orders/:opaque_token/status', async (request, reply) => {
    const { opaque_token } = request.params;
    const order = await checkoutService.getOrderStatus(opaque_token);
    return reply.send(order);
  });

  return app;
}

if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const server = await buildApp();
  try {
    await server.listen({ port: config.port, host: config.host });
    console.log(`[Server] NOVARUM Commerce Engine running at http://${config.host}:${config.port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}
