import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { db } from './db/pool.js';
import { CheckoutService } from './services/checkout.service.js';

export async function buildApp(customDb = db) {
  const app = Fastify({
    logger: config.nodeEnv === 'development' ? {
      level: 'info',
      serializers: {
        req(req) {
          // Zero PII sanitizer for request logs
          return {
            method: req.method,
            url: req.url,
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
    disableRequestLogging: false,
  });

  // CORS Configuration
  await app.register(cors, {
    origin: (origin, cb) => {
      // Allow requests with no origin (like mobile apps, curl, or server-to-server)
      if (!origin) return cb(null, true);
      if (config.allowedOrigins.includes(origin)) {
        return cb(null, true);
      }
      return cb(new Error('Not allowed by CORS'), false);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: true,
  });

  const checkoutService = new CheckoutService(customDb, config.defaultAcademyId);

  // Global Error Handler for Controlled, Sanitized Responses
  app.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode || 500;
    
    // Log sanitized error internally without exposing SQL or stack trace to client
    request.log.error({
      errCode: error.code,
      message: error.message,
      statusCode,
    }, 'Handled application error');

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

  // GET /api/v1/orders/:opaque_token/status (Zero PII)
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
