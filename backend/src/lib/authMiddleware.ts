// Auth middleware - verifies JWT token and attaches user to request
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import prisma from './prisma.js';
import { isFullAdmin, hasAdminAccess, isSuperAdmin } from './platformRoles.js';

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
    // Allow internal API calls with shared secret (for webhook auto-deploy)
    const internalSecret = req.headers['x-internal-secret'];
    if (internalSecret && internalSecret === INTERNAL_API_SECRET) {
      req.user = { userId: 'internal', email: 'internal@docklift', role: 'admin' };
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
