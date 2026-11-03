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

  const defaultSerializers = {
    req(req) {
      // Use router matched route template, or fixed 'unknown_route' for unknown/malformed routes
      // Never store raw URLs, query strings, path params, or sentinels
      const route = req.routeOptions?.url || 'unknown_route';
      return {
        method: req.method,
        route,
      };
    },
    res(res) {
      return {
        statusCode: res.statusCode,
      };
    },
    err(err) {
      // Never serialize raw error.message which might contain user input or sensitive tokens
      return {
        code: err.code || 'ERROR',
        statusCode: err.statusCode || 500,
      };
    }
  };

  let loggerConfig = false;
  if (opts.logger !== undefined) {
    if (typeof opts.logger === 'object' && opts.logger !== null) {
      loggerConfig = {
        serializers: defaultSerializers,
        ...opts.logger,
        serializers: {
          ...defaultSerializers,
          ...(opts.logger.serializers || {})
        }
      };
    } else {
      loggerConfig = opts.logger;
    }
  } else if (config.nodeEnv === 'development') {
    loggerConfig = {
      level: 'info',
      serializers: defaultSerializers
    };
  }

  const app = Fastify({
    logger: loggerConfig,
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

  // Strict 404 handler: sanitize unknown, incomplete, or malformed routes (P1)
  // Replaces Fastify default 404 handler to ensure raw URLs and queries are never logged
  app.setNotFoundHandler((request, reply) => {
    request.log.warn({
      route: 'unknown_route',
      statusCode: 404
    }, 'Route not found');

    reply.code(404).send({
      error: 'NOT_FOUND',
      message: 'Resource not found'
    });
  });

  // Global Error Handler for Controlled, Sanitized Responses
  // Never log raw URL, query strings, path params, email, tokens, SKU, or error.message for 4xx/5xx
  app.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode || 500;
    const route = request.routeOptions?.url || 'unknown_route';
    
    // Log only sanitized attributes with static message strings (no raw error.message in logs)
    request.log.error({
      route,
      errCode: error.code || 'ERROR',
      statusCode,
    }, statusCode >= 500 ? 'Internal server error' : 'Handled request error');

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
      message: error.message || 'Request could not be processed',
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
