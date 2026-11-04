import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  defaultAcademyId: process.env.DEFAULT_ACADEMY_ID || 'dr-sevilla',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'https://drpedrosevilla.com,https://www.drpedrosevilla.com,https://pedrosevilla.novaforge.group,http://localhost:3000,http://127.0.0.1:3000,http://localhost:8080,http://127.0.0.1:8080,http://localhost:8090,http://127.0.0.1:8090').split(','),
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/novarum_b2c_commerce',
  idempotencySalt: process.env.IDEMPOTENCY_SECRET_SALT || 'default_salt_change_in_gsm',
};
