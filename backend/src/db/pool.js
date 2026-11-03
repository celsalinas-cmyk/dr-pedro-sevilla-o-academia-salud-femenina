import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

export class Database {
  constructor(customPool = null) {
    this.pool = customPool || new Pool({
      connectionString: config.databaseUrl,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }

  async query(text, params) {
    return this.pool.query(text, params);
  }

  async getClient() {
    return this.pool.connect();
  }

  async close() {
    return this.pool.end();
  }
}

export const db = new Database();
