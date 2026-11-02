import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Pool } = pg;

export class RealPostgresTestEnvironment {
  constructor(port = 54329) {
    this.port = port;
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
      // Otherwise, use portable embedded-postgres (supports macOS, Linux x64/arm64, Windows)
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
    }

    // 2. Connect pg pool
    this.pool = new Pool({
      connectionString,
      max: 25, // generous pool for concurrency testing
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });

    // 3. Run original migrations directly
    const migrationsDir = path.join(__dirname, '../migrations');
    const files = fs.readdirSync(migrationsDir).sort();

    for (const file of files) {
      if (file.endsWith('.sql')) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        await this.pool.query(sql);
      }
    }

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
