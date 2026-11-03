import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runMigrations } from '../src/db/migrate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Pool } = pg;

export class RealPostgresTestEnvironment {
  constructor(port = 54329, maxPool = 25) {
    this.port = port;
    this.maxPool = maxPool;
    this.externalDbUrl = process.env.TEST_DATABASE_URL || null;
    this.dataDir = path.join(__dirname, '../data/test-pg-' + port);
    this.embedded = null;
    this.pool = null;
  }

  async start() {
    let connectionString;

    // 1. If an external or Docker test database URL is provided, use it
    if (this.externalDbUrl) {
      console.log(`[Test DB] Using external PostgreSQL at: ${this.externalDbUrl.replace(/:[^:@]+@/, ':***@')}`);
      connectionString = this.externalDbUrl;
    } else {
      // Otherwise, attempt to use embedded-postgres if available locally
      try {
        const mod = await import('embedded-postgres');
        const EmbeddedPostgres = mod.default || mod;
        this.embedded = new EmbeddedPostgres({
          port: this.port,
          user: 'postgres',
          password: 'password',
          persistent: false,
          dataDir: this.dataDir
        });
        await this.embedded.initialise();
        await this.embedded.start();
        connectionString = `postgresql://postgres:password@127.0.0.1:${this.port}/postgres`;
      } catch (err) {
        throw new Error(
          `PostgreSQL is required for integration tests. Either set TEST_DATABASE_URL (e.g. in CI or Docker) or install embedded-postgres locally. Error: ${err.message}`
        );
      }
    }

    // 2. Connect pg pool with explicit maxPool size (tested at max=5!)
    this.pool = new Pool({
      connectionString,
      max: this.maxPool,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });

    // 3. Run original migrations using the advisory lock & schema_migrations journal
    await runMigrations(this);

    return this;
  }

  async query(text, params) {
    return this.pool.query(text, params);
  }

  async getClient() {
    return this.pool.connect();
  }

  async stop() {
    if (this.pool) {
      await this.pool.end();
    }
    if (this.embedded) {
      await this.embedded.stop();
      try {
        fs.rmSync(this.dataDir, { recursive: true, force: true });
      } catch (_) {}
    }
  }
}
