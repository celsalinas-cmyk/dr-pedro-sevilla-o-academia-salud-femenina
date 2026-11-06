import crypto from 'crypto';
import { parse as parseCookie, serialize as serializeCookie } from 'cookie';

export const ADMIN_ROLES = Object.freeze({
  ACADEMIC_OPERATOR: 'academic_operator',
  FINANCE_VERIFIER: 'finance_verifier',
  ACADEMY_ADMIN: 'academy_admin',
});

export const SESSION_COOKIE_NAME = 'novarum_admin_session';
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours maximum TTL

const SPOOFED_IDENTITY_FIELDS = new Set([
  'operator_id',
  'operatorId',
  'operator_role',
  'operatorRole',
  'role',
  'academy_id',
  'academyId',
  'verified_by_operator_id',
  'reversed_by_operator_id',
  'reallocated_by_operator_id',
]);

export function hashPassword(plainPassword) {
  if (!plainPassword || typeof plainPassword !== 'string' || plainPassword.length < 8) {
    throw new Error('Password must be a string of at least 8 characters.');
  }
  const salt = crypto.randomBytes(16);
  const derivedKey = crypto.scryptSync(plainPassword, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derivedKey.toString('hex')}`;
}

export function verifyPassword(plainPassword, storedHash) {
  if (!plainPassword || typeof plainPassword !== 'string' || !storedHash || typeof storedHash !== 'string') {
    return false;
  }
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }
  const [, saltHex, hashHex] = parts;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expectedHash = Buffer.from(hashHex, 'hex');
    if (salt.length !== 16 || expectedHash.length !== 64) {
      return false;
    }
    const derivedKey = crypto.scryptSync(plainPassword, salt, 64);
    return crypto.timingSafeEqual(expectedHash, derivedKey);
  } catch (_) {
    return false;
  }
}

export function hashSessionToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export class AdminAuthService {
  constructor(database, defaultAcademyId = 'dr-sevilla', allowedOrigins = []) {
    this.db = database;
    this.defaultAcademyId = defaultAcademyId;
    this.allowedOrigins = allowedOrigins;
  }

  /**
   * Deterministic bootstrap of nominal operators for the academy (no user CRUD endpoints).
   */
  async bootstrapOperators(operators = []) {
    for (const op of operators) {
      const passwordHash = op.password_hash || hashPassword(op.password);
      await this.db.query(
        `INSERT INTO admin_operators (academy_id, operator_id, display_name, role, password_hash, is_active, session_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (academy_id, operator_id)
         DO UPDATE SET
           display_name = EXCLUDED.display_name,
           role = EXCLUDED.role,
           password_hash = EXCLUDED.password_hash,
           is_active = EXCLUDED.is_active`,
        [
          op.academy_id || this.defaultAcademyId,
          op.operator_id,
          op.display_name || op.operator_id,
          op.role,
          passwordHash,
          op.is_active !== undefined ? op.is_active : true,
          op.session_version || 1,
        ]
      );
    }
  }

  /**
   * Authenticates nominal operator credentials and creates a revocable 8h server-side session.
   */
  async login(input, opts = {}) {
    if (!input || typeof input !== 'object') {
      const err = new Error('Login payload must be a JSON object.');
      err.statusCode = 422;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    for (const forbiddenField of ['role', 'operator_role', 'operatorRole', 'academy_id', 'academyId']) {
      if (Object.prototype.hasOwnProperty.call(input, forbiddenField)) {
        const err = new Error(`Client payload is forbidden from supplying or overriding identity field '${forbiddenField}'.`);
        err.statusCode = 403;
        err.code = 'OPERATOR_SPOOFING_FORBIDDEN';
        throw err;
      }
    }

    const operatorId = typeof input.operator_id === 'string' ? input.operator_id.trim() : '';
    const password = typeof input.password === 'string' ? input.password : '';

    if (!operatorId || !password) {
      const err = new Error('operator_id and password are required.');
      err.statusCode = 401;
      err.code = 'INVALID_ADMIN_CREDENTIALS';
      throw err;
    }

    const academyId = this.defaultAcademyId;
    const opRes = await this.db.query(
      `SELECT academy_id, operator_id, display_name, role, password_hash, is_active, session_version
       FROM admin_operators
       WHERE academy_id = $1 AND operator_id = $2`,
      [academyId, operatorId]
    );

    if (opRes.rows.length === 0) {
      const err = new Error('Invalid operator credentials or inactive operator.');
      err.statusCode = 401;
      err.code = 'INVALID_ADMIN_CREDENTIALS';
      throw err;
    }

    const operator = opRes.rows[0];
    if (!operator.is_active || !verifyPassword(password, operator.password_hash)) {
      const err = new Error('Invalid operator credentials or inactive operator.');
      err.statusCode = 401;
      err.code = 'INVALID_ADMIN_CREDENTIALS';
      throw err;
    }

    const sessionId = crypto.randomUUID();
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashSessionToken(rawToken);
    const csrfToken = crypto.randomBytes(32).toString('hex');
    const now = opts.now ? new Date(opts.now) : new Date();
    const expiresAt = new Date(now.getTime() + (opts.ttlMs || SESSION_TTL_MS));

    await this.db.query(
      `INSERT INTO admin_sessions (
         id, academy_id, operator_id, token_hash, csrf_token, session_version, created_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        sessionId,
        academyId,
        operator.operator_id,
        tokenHash,
        csrfToken,
        operator.session_version,
        now,
        expiresAt,
      ]
    );

    return {
      sessionId,
      rawToken,
      csrfToken,
      expiresAt,
      operator: {
        operator_id: operator.operator_id,
        academy_id: operator.academy_id,
        display_name: operator.display_name,
        role: operator.role,
      },
    };
  }

  /**
   * Formats the HttpOnly, Secure, SameSite=Strict session cookie.
   */
  formatSessionCookie(rawToken, maxAgeSeconds = 8 * 60 * 60) {
    return serializeCookie(SESSION_COOKIE_NAME, rawToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/api/v1/admin',
      maxAge: maxAgeSeconds,
    });
  }

  formatClearSessionCookie() {
    return serializeCookie(SESSION_COOKIE_NAME, '', {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/api/v1/admin',
      maxAge: 0,
    });
  }

  /**
   * Extracts raw session token from Cookie or Authorization Bearer header.
   */
  extractRawToken(request) {
    const authHeader = request.headers?.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const bearer = authHeader.slice(7).trim();
      if (bearer) return bearer;
    }

    const cookieHeader = request.headers?.cookie;
    if (typeof cookieHeader === 'string' && cookieHeader.length > 0) {
      const parsed = parseCookie(cookieHeader);
      if (parsed[SESSION_COOKIE_NAME]) {
        return parsed[SESSION_COOKIE_NAME].trim();
      }
    }

    return null;
  }

  /**
   * Immediately revokes a session by raw token.
   */
  async logout(rawToken, reason = 'operator_logout') {
    if (!rawToken || typeof rawToken !== 'string') {
      const err = new Error('Authentication required.');
      err.statusCode = 401;
      err.code = 'ADMIN_AUTH_REQUIRED';
      throw err;
    }

    const tokenHash = hashSessionToken(rawToken);
    const res = await this.db.query(
      `UPDATE admin_sessions
       SET revoked_at = COALESCE(revoked_at, NOW()),
           revoke_reason = COALESCE(revoke_reason, $1)
       WHERE academy_id = $2 AND token_hash = $3
       RETURNING id`,
      [reason, this.defaultAcademyId, tokenHash]
    );

    if (res.rows.length === 0) {
      const err = new Error('Invalid session.');
      err.statusCode = 401;
      err.code = 'SESSION_INVALID';
      throw err;
    }

    return { revoked: true };
  }

  /**
   * Emergency administrative revocation of all active sessions for an operator.
   */
  async revokeOperatorSessions(operatorId, reason = 'admin_revocation') {
    const academyId = this.defaultAcademyId;
    await this.db.query(
      `UPDATE admin_operators
       SET session_version = session_version + 1,
           updated_at = NOW()
       WHERE academy_id = $1 AND operator_id = $2`,
      [academyId, operatorId]
    );

    await this.db.query(
      `UPDATE admin_sessions
       SET revoked_at = COALESCE(revoked_at, NOW()),
           revoke_reason = COALESCE(revoke_reason, $1)
       WHERE academy_id = $2 AND operator_id = $3 AND revoked_at IS NULL`,
      [reason, academyId, operatorId]
    );
  }

  /**
   * Rejects any client attempt to spoof or override operator_id, role, or academy_id in body/query.
   */
  assertNoIdentitySpoofing(payload, query) {
    for (const source of [payload, query]) {
      if (source && typeof source === 'object' && !Array.isArray(source)) {
        for (const key of Object.keys(source)) {
          if (SPOOFED_IDENTITY_FIELDS.has(key)) {
            const err = new Error(`Client payload is forbidden from supplying or overriding identity field '${key}'.`);
            err.statusCode = 403;
            err.code = 'OPERATOR_SPOOFING_FORBIDDEN';
            throw err;
          }
        }
      }
    }
  }

  /**
   * Validates session, revocation, expiration, CSRF protection, anti-spoofing, and role permissions.
   */
  async authenticateRequest(request, { requireCsrf = false, allowedRoles = [], checkSpoofing = true } = {}) {
    const rawToken = this.extractRawToken(request);
    if (!rawToken || !/^[0-9a-f]{64}$/i.test(rawToken)) {
      const err = new Error('Administrative session authentication is required.');
      err.statusCode = 401;
      err.code = 'ADMIN_AUTH_REQUIRED';
      throw err;
    }

    const tokenHash = hashSessionToken(rawToken);
    const academyId = this.defaultAcademyId;

    const res = await this.db.query(
      `SELECT s.id AS session_id, s.academy_id, s.operator_id, s.csrf_token,
              s.session_version AS token_session_version, s.expires_at, s.revoked_at,
              o.display_name, o.role, o.is_active, o.session_version AS current_session_version
       FROM admin_sessions s
       JOIN admin_operators o
         ON o.academy_id = s.academy_id AND o.operator_id = s.operator_id
       WHERE s.academy_id = $1 AND s.token_hash = $2`,
      [academyId, tokenHash]
    );

    if (res.rows.length === 0) {
      const err = new Error('Invalid administrative session.');
      err.statusCode = 401;
      err.code = 'SESSION_INVALID';
      throw err;
    }

    const row = res.rows[0];

    if (row.revoked_at !== null && row.revoked_at !== undefined) {
      const err = new Error('Administrative session has been revoked.');
      err.statusCode = 401;
      err.code = 'SESSION_REVOKED';
      throw err;
    }

    if (!row.is_active || row.token_session_version !== row.current_session_version) {
      const err = new Error('Operator account is inactive or session version was invalidated.');
      err.statusCode = 401;
      err.code = 'OPERATOR_SESSION_INVALIDATED';
      throw err;
    }

    if (new Date(row.expires_at) <= new Date()) {
      const err = new Error('Administrative session has expired.');
      err.statusCode = 401;
      err.code = 'SESSION_EXPIRED';
      throw err;
    }

    if (requireCsrf) {
      const origin = request.headers?.origin;
      if (origin && this.allowedOrigins.length > 0 && !this.allowedOrigins.includes(origin)) {
        const err = new Error('Request origin is not permitted for administrative mutations.');
        err.statusCode = 403;
        err.code = 'ORIGIN_NOT_ALLOWED';
        throw err;
      }

      const csrfHeader = request.headers?.['x-csrf-token'];
      if (!csrfHeader || typeof csrfHeader !== 'string') {
        const err = new Error('Missing X-CSRF-Token header for administrative mutation.');
        err.statusCode = 403;
        err.code = 'CSRF_TOKEN_INVALID';
        throw err;
      }

      const expectedBuf = Buffer.from(row.csrf_token, 'utf8');
      const actualBuf = Buffer.from(csrfHeader.trim(), 'utf8');
      if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
        const err = new Error('Invalid X-CSRF-Token header for administrative mutation.');
        err.statusCode = 403;
        err.code = 'CSRF_TOKEN_INVALID';
        throw err;
      }
    }

    if (checkSpoofing) {
      this.assertNoIdentitySpoofing(request.body, request.query);
    }

    if (allowedRoles.length > 0 && !allowedRoles.includes(row.role)) {
      const err = new Error(`Role '${row.role}' is not authorized to perform this operation.`);
      err.statusCode = 403;
      err.code = 'INSUFFICIENT_ROLE_PERMISSIONS';
      throw err;
    }

    return {
      sessionId: row.session_id,
      rawToken,
      academyId: row.academy_id,
      operatorId: row.operator_id,
      displayName: row.display_name,
      role: row.role,
      csrfToken: row.csrf_token,
    };
  }
}
