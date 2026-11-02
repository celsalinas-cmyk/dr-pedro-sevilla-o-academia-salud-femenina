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

  // Health check endpoint
  app.get('/health', async () => {
    return { status: 'healthy', academy: config.defaultAcademyId };
  });

  // POST /api/v1/checkout
  app.post('/api/v1/checkout', async (request, reply) => {
    try {
      const clientIp = request.ip;
      const userAgent = request.headers['user-agent'] || '';
      
      const result = await checkoutService.processCheckout(request.body || {}, clientIp, userAgent);
      
      return reply.code(result.statusCode).send(result.order);
    } catch (err) {
      const statusCode = err.statusCode || 500;
      return reply.code(statusCode).send({
        error: err.code || 'INTERNAL_ERROR',
        message: err.message,
      });
    }
  });

  // GET /api/v1/orders/:opaque_token/status (Zero PII)
  app.get('/api/v1/orders/:opaque_token/status', async (request, reply) => {
    try {
      const { opaque_token } = request.params;
      const order = await checkoutService.getOrderStatus(opaque_token);
      return reply.send(order);
    } catch (err) {
      const statusCode = err.statusCode || 500;
      return reply.code(statusCode).send({
        error: err.code || 'INTERNAL_ERROR',
        message: err.message,
      });
    }
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
