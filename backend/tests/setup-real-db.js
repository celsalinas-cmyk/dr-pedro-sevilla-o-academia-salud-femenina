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
    this.dataDir = path.join(__dirname, '../data/test-pg-' + port);
    this.embedded = new EmbeddedPostgres({
      port: this.port,
      user: 'postgres',
      password: 'password',
      persistent: false,
      dataDir: this.dataDir
    });
    this.pool = null;
  }

  async start() {
    // 1. Initialise and start embedded Postgres cluster
    await this.embedded.initialise();
    await this.embedded.start();

    // 2. Connect pg pool to the default 'postgres' database
    this.pool = new Pool({
      connectionString: `postgresql://postgres:password@127.0.0.1:${this.port}/postgres`,
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
    await this.embedded.stop();
    // Clean up data directory
    try {
      fs.rmSync(this.dataDir, { recursive: true, force: true });
    } catch (_) {}
  }
}
