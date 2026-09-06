// Auth middleware - verifies JWT token and attaches user to request
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import prisma from './prisma.js';
import { isFullAdmin, hasAdminAccess, isSuperAdmin } from './platformRoles.js';
import { assertSessionLive, authenticateApiKey, touchSession } from './security.js';

// Generate secure random secret
const generateSecureSecret = () => crypto.randomBytes(64).toString('hex');

// Secrets file path in data directory
const SECRETS_FILE = path.join(config.dataPath, '.secrets');

// Load or generate secrets with auto-persistence
function loadOrCreateSecrets(): { jwtSecret: string; internalApiSecret: string } {
  // Priority 1: Environment variables (explicit configuration)
  if (process.env.JWT_SECRET && process.env.INTERNAL_API_SECRET) {
    console.log('🔐 Using secrets from environment variables');
    return {
      jwtSecret: process.env.JWT_SECRET,
      internalApiSecret: process.env.INTERNAL_API_SECRET,
    };
  }

  // Priority 2: Load from persisted secrets file
  try {
    if (fs.existsSync(SECRETS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf-8'));
      if (data.jwtSecret && data.internalApiSecret) {
        console.log('🔐 Loaded persisted secrets');
        return data;
      }
    }
  } catch (error) {
    console.warn('⚠️  Failed to load secrets file, generating new ones');
  }

  // Priority 3: Generate new secrets and persist them
  const secrets = {
    jwtSecret: process.env.JWT_SECRET || generateSecureSecret(),
    internalApiSecret: process.env.INTERNAL_API_SECRET || generateSecureSecret(),
  };

  // Ensure data directory exists
  if (!fs.existsSync(config.dataPath)) {
    fs.mkdirSync(config.dataPath, { recursive: true });
  }

  // Save secrets to file (mode 0o600 = owner read/write only)
  try {
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    console.log('🔐 Generated and saved new secrets');
  } catch (error) {
    console.warn('⚠️  Could not persist secrets (sessions will reset on restart)');
  }

  return secrets;
}

const secrets = loadOrCreateSecrets();
const JWT_SECRET = secrets.jwtSecret;
const INTERNAL_API_SECRET = secrets.internalApiSecret;

export interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    email: string;
    role: string;
    purpose?: string;
  };
  /**
   * Set when the caller authenticated with a machine API key (spec §31) instead of
   * a session JWT. Its `permissions` are the caller's whole grant — see
   * `requestPermissions` in adminPermissions.ts, which is what stops a key from
   * inheriting the `admin` role it authenticates as.
   *
   * Typed structurally rather than importing `ApiKeyIdentity` from security.ts,
   * which imports this module.
   */
  adminKey?: { id: string; name: string; permissions: string[] };
}

// Export for use in auth.ts and github.ts
export { JWT_SECRET, INTERNAL_API_SECRET };

export type JwtPayload = {
  userId: string;
  email: string;
  role: string;
  purpose?: string;
  pwdv?: number;
  iat?: number;
  exp?: number;
};

function authError(res: Response, error: any) {
  if (error?.name === 'JsonWebTokenError') {
    return res.status(401).json({ error: 'Invalid token' });
  }
  if (error?.name === 'TokenExpiredError') {
    return res.status(401).json({ error: 'Token expired' });
  }
  return res.status(500).json({ error: 'Authentication failed' });
}

/** Reject session JWTs issued before the user's last password change, or for suspended users. */
export async function assertPasswordStillValid(decoded: JwtPayload): Promise<string | null> {
  if (!decoded.userId || decoded.userId === 'internal') return null;
  try {
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { passwordChangedAt: true, status: true },
    });
    if (!user) return 'User not found';
    // Fail-closed session lockout: a suspended user's live JWTs stop working immediately.
    if (user.status === 'suspended') {
      return 'Account suspended. Contact an administrator.';
    }
    const expectedPwdv = user.passwordChangedAt?.getTime() ?? 0;
    if (typeof decoded.pwdv !== 'number' || decoded.pwdv !== expectedPwdv) {
      return 'Session expired. Please log in again.';
    }
  } catch {
    // Fail closed: DB/schema errors must not let revoked sessions through
    return 'Authentication temporarily unavailable';
  }
  return null;
}

/**
 * Default API auth: Authorization Bearer session JWT only.
 * Does NOT accept query tokens (prevents SSE/terminal tokens from authorizing DELETE/reboot/etc).
 */
export const authMiddleware = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    // A machine API key already authenticated this request (adminApiKeyAuth runs
    // ahead of this on the admin mounts). It carries no JWT, so the header checks
    // below would refuse it.
    if (req.adminKey) {
      return next();
    }

    // Allow internal API calls with shared secret (for webhook auto-deploy)
    const internalSecret = req.headers['x-internal-secret'];
    if (internalSecret && internalSecret === INTERNAL_API_SECRET) {
      req.user = { userId: 'internal', email: 'internal@godhosting', role: 'admin' };
      return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;

    // Short-lived purpose tokens must not authenticate normal API calls
    if (decoded.purpose === 'sse' || decoded.purpose === 'terminal') {
      return res.status(401).json({ error: 'Invalid token for this endpoint' });
    }

    const pwdErr = await assertPasswordStillValid(decoded);
    if (pwdErr) {
      return res.status(401).json({ error: pwdErr });
    }

    // Operator sessions can be revoked from Admin → Security (§30). Only operator
    // tokens are checked: those are the only ones the sessions table records, so for
    // a customer this would be a guaranteed-miss query on every request.
    if (hasAdminAccess(decoded.role)) {
      const sessionErr = await assertSessionLive(token);
      if (sessionErr) {
        return res.status(401).json({ error: sessionErr });
      }
      touchSession(token);
    }

    req.user = {
      userId: decoded.userId,
      email: decoded.email,
      role: decoded.role,
    };
    next();
  } catch (error: any) {
    return authError(res, error);
  }
};

/**
 * Authenticate `x-admin-api-key` (spec §31). Mount on the admin API *before*
 * `authMiddleware`; a request without the header passes straight through to normal
 * JWT auth, so this is additive.
 *
 * The identity it attaches claims `role: 'admin'` purely to clear the entry gate.
 * Authorization comes from the key's own permission list — `requestPermissions`
 * ignores the role whenever `req.adminKey` is set.
 */
export const adminApiKeyAuth = async (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
) => {
  try {
    const identity = await authenticateApiKey(req);
    if (identity) {
      req.adminKey = identity;
      req.user = {
        userId: `apikey:${identity.id}`,
        email: `key:${identity.name}`,
        role: 'admin',
      };
    }
  } catch {
    // Fall through to JWT auth; a broken key lookup is a 401, not a 500.
  }
  next();
};

/**
 * Replace the JWT's copy of the role with the live one from the database.
 *
 * The token carries the role it was minted with and lives for seven days, so
 * demoting an operator — or the moment they lose admin access entirely — would
 * otherwise take effect a week late. The permission gate below reads
 * `req.user.role`, so refreshing it here is what makes "the backend is the source
 * of truth" (§61) true for authorization and not just for data.
 *
 * One indexed lookup per admin request. Admin traffic is a rounding error next to
 * the tenant API, and the alternative — trusting a week-old claim — is not a
 * trade-off worth making.
 */
export const attachLiveRole = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  // API keys have no User row, and `internal` is the webhook secret, not an account.
  if (req.adminKey || !req.user || req.user.userId === 'internal') return next();
  try {
    const live = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { role: true, status: true },
    });
    if (!live) {
      return res.status(401).json({ error: 'Account no longer exists.' });
    }
    if (live.status !== 'active') {
      return res.status(403).json({ error: 'Account is not active.' });
    }
    req.user.role = live.role;
  } catch {
    // Fail closed: an unreadable role is not an admin role.
    return res.status(503).json({ error: 'Authorization temporarily unavailable' });
  }
  next();
};

/**
 * SSE-only auth: query ?token= with purpose === 'sse'.
 * Mount exclusively on log stream routes (EventSource cannot set Authorization headers).
 */
export const sseAuthMiddleware = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const queryToken = req.query.token as string | undefined;
    if (!queryToken) {
      return res.status(401).json({ error: 'SSE token required' });
    }

    const decoded = jwt.verify(queryToken, JWT_SECRET) as JwtPayload;
    if (decoded.purpose !== 'sse') {
      return res.status(401).json({ error: 'SSE token required' });
    }

    const pwdErr = await assertPasswordStillValid(decoded);
    if (pwdErr) {
      return res.status(401).json({ error: pwdErr });
    }

    req.user = {
      userId: decoded.userId,
      email: decoded.email,
      role: decoded.role,
      purpose: 'sse',
    };
    next();
  } catch (error: any) {
    return authError(res, error);
  }
};

export default authMiddleware;

/** True for full-admin sessions (owner/super_admin/admin) and internal (webhook)
 * calls, which bypass ownership + quotas. A read-only `viewer` is NOT admin here:
 * it must never gain cross-tenant write or quota bypass — its reach is confined to
 * the ops-center router's own queries (see requireAdminAccess). */
export function isAdmin(req: AuthenticatedRequest): boolean {
  return isFullAdmin(req.user?.role);
}

/**
 * Gate a router to full admins only (owner/super_admin/admin). Mount AFTER
 * authMiddleware (needs req.user). Returns 403 for authenticated non-admins.
 * This is the REAL admin gate — the frontend role check is cosmetic.
 */
export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!isAdmin(req)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Ops-center entry gate: any admin tier INCLUDING the read-only `viewer`. Pair
 * this with `requireAdminWrite` on the same router so viewers can read every GET
 * but every mutation still demands a full admin.
 */
export function requireAdminAccess(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!hasAdminAccess(req.user?.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Router-level write gate: GET/HEAD pass (so viewers keep read access), any other
 * method requires a full admin. Returns 403 with a role-specific message so a
 * viewer sees *why* the action is blocked, not a generic denial.
 */
export function requireAdminWrite(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (!isAdmin(req)) {
    return res.status(403).json({ error: 'This action requires an administrator; your access is read-only.' });
  }
  next();
}

/** Gate an action to super-admins and the owner (managing other admin accounts). */
export function requireSuperAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!isSuperAdmin(req.user?.role)) {
    return res.status(403).json({ error: 'This action requires a super administrator.' });
  }
  next();
}

/** Thrown by access/quota checks; carries the HTTP status to send. */
export interface AccessError {
  status: number;
  message: string;
}

function isAccessError(err: unknown): err is AccessError {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as AccessError).status === 'number' &&
    typeof (err as AccessError).message === 'string'
  );
}

/**
 * Map a thrown AccessError to an HTTP response. Returns true if it handled the
 * error, false if the caller should treat it as an unexpected 500.
 */
export function sendAccessError(res: Response, err: unknown): boolean {
  if (isAccessError(err)) {
    res.status(err.status).json({ error: err.message });
    return true;
  }
  return false;
}

/**
 * Assert the caller may access a project, returning it. Admin/internal see all.
 * A non-owner gets 404 (not 403) to hide existence and prevent ID enumeration.
 */
export async function assertProjectAccess(req: AuthenticatedRequest, projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw { status: 404, message: 'Project not found' } as AccessError;
  if (isAdmin(req)) return project;
  if (project.user_id !== req.user?.userId) {
    throw { status: 404, message: 'Project not found' } as AccessError;
  }
  return project;
}
