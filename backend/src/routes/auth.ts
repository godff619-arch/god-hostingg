// Auth routes - registration, login, logout, session check
import express, { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import prisma from '../lib/prisma.js';
import { JWT_SECRET, authMiddleware, requireAdmin } from '../lib/authMiddleware.js';
import { config } from '../lib/config.js';
import { getSetting, getBoolSetting } from '../lib/settings.js';
import { writeAudit, clientIp } from '../lib/audit.js';
import { hasAdminAccess } from '../lib/platformRoles.js';
import {
  recordLoginAttempt,
  recordSession,
  revokeSessionsForUser,
} from '../lib/security.js';
import {
  ensureBootstrapSecret,
  verifyBootstrapSecret,
  consumeBootstrapSecret,
  tryClaimBootstrapSecret,
  verifyBootstrapSecretAtPath,
  finalizeBootstrapClaim,
  abortBootstrapClaim,
  isBootstrapRequired,
  tryLockFirstAccount,
  releaseFirstAccountLock,
} from '../lib/bootstrap.js';

const router = express.Router();

const JWT_EXPIRES_IN = '7d';

const BOOTSTRAP_HINT =
  'Bootstrap secret required. Copy it from the backend logs (or data/.bootstrap-secret on the host).';

function requireBootstrap(req: Request, res: Response): boolean {
  const header = (req.headers['x-bootstrap-secret'] as string | undefined)?.trim();
  const bodySecret = typeof req.body?.bootstrapSecret === 'string' ? req.body.bootstrapSecret.trim() : undefined;
  const provided = header || bodySecret;
  if (!verifyBootstrapSecret(provided)) {
    res.status(403).json({ error: BOOTSTRAP_HINT });
    return false;
  }
  return true;
}

function signSessionToken(user: {
  id: string;
  email: string;
  role: string;
  passwordChangedAt?: Date | null;
}) {
  const pwdv = user.passwordChangedAt?.getTime() ?? 0;
  return jwt.sign(
    { userId: user.id, email: user.email, role: user.role, pwdv },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/**
 * Sign a session token and, for an account that reaches the admin panel, record the
 * session so Admin → Security can list and revoke it (spec §30).
 *
 * The row's expiry is read back off the signed token instead of recomputed from
 * `JWT_EXPIRES_IN`, so the table and the credential can never disagree about when
 * the session ends. Customer sessions are not recorded — see lib/security.ts.
 */
async function issueSession(
  req: Request,
  user: { id: string; email: string; role: string; passwordChangedAt?: Date | null },
): Promise<string> {
  const token = signSessionToken(user);
  if (hasAdminAccess(user.role)) {
    const decoded = jwt.decode(token) as { exp?: number } | null;
    const expiresAt = decoded?.exp
      ? new Date(decoded.exp * 1000)
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await recordSession(req, { userId: user.id, token, expiresAt });
  }
  return token;
}

// Check if setup is complete (any users exist)
router.get('/status', async (req: Request, res: Response) => {
  try {
    const userCount = await prisma.user.count();
    const bootstrapRequired = userCount === 0 && isBootstrapRequired();
    // Ensure secret exists for fresh installs (does not expose it)
    if (bootstrapRequired) {
      ensureBootstrapSecret();
    }
    const registrationEnabled = await getBoolSetting('registration_enabled', true);
    res.json({
      setupComplete: userCount > 0,
      userCount,
      bootstrapRequired,
      registrationEnabled,
    });
  } catch (error: any) {
    // If database doesn't exist or table missing, setup is not complete
    if (error.message?.includes('does not exist') || error.code === 'P2021') {
      const bootstrapRequired = isBootstrapRequired();
      if (bootstrapRequired) ensureBootstrapSecret();
      return res.json({
        setupComplete: false,
        userCount: 0,
        needsRestore: true,
        bootstrapRequired,
      });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Register first user (only if no users exist). The bootstrap secret is demanded
// only when REQUIRE_BOOTSTRAP_SECRET is set; by default the first signup wins and
// becomes OWNER (see lib/bootstrap.ts for why one-click hosts need that).
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const userCount = await prisma.user.count();
    if (userCount > 0) {
      return res.status(403).json({ error: 'Setup already complete. Use login instead.' });
    }

    const secretRequired = isBootstrapRequired();
    if (secretRequired && !requireBootstrap(req, res)) return;

    const header = (req.headers['x-bootstrap-secret'] as string | undefined)?.trim();
    const bodySecret =
      typeof req.body?.bootstrapSecret === 'string' ? req.body.bootstrapSecret.trim() : undefined;
    const providedBootstrap = header || bodySecret;

    // One winner only: an exclusive filesystem claim in both modes.
    const claimPath = secretRequired ? tryClaimBootstrapSecret() : tryLockFirstAccount();
    if (!claimPath) {
      return res.status(403).json({ error: 'Registration unavailable. Setup may already be in progress or complete.' });
    }
    const releaseClaim = () =>
      secretRequired ? abortBootstrapClaim(claimPath) : releaseFirstAccountLock(claimPath);

    try {
      if (secretRequired && !verifyBootstrapSecretAtPath(claimPath, providedBootstrap)) {
        releaseClaim();
        return res.status(403).json({ error: BOOTSTRAP_HINT });
      }

      const userCountAfterClaim = await prisma.user.count();
      if (userCountAfterClaim > 0) {
        releaseClaim();
        return res.status(403).json({ error: 'Setup already complete. Use login instead.' });
      }

      const hashedPassword = await bcrypt.hash(password, 12);
      const now = new Date();

      const user = await prisma.user.create({
        data: {
          name,
          email: email.toLowerCase(),
          password: hashedPassword,
          // First account is the platform OWNER: the single untouchable root that
          // can manage every other admin tier (see lib/platformRoles.ts).
          role: 'owner',
          passwordChangedAt: now,
        },
      });

      if (secretRequired) finalizeBootstrapClaim(claimPath);
      else releaseFirstAccountLock(claimPath);
      // Always drop the secret: the claim window is closed now either way.
      consumeBootstrapSecret();

      const token = await issueSession(req, user);

      res.status(201).json({
        message: 'Registration successful',
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
      });
    } catch (innerError: any) {
      releaseClaim();
      throw innerError;
    }
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'Email already exists' });
    }
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Public self-service signup — creates a regular (role='user') account.
// Gated by the admin `registration_enabled` setting. Never creates an admin and
// never touches the bootstrap secret (that path is /register, first user only).
router.post('/signup', async (req: Request, res: Response) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const emailNorm = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
      return res.status(400).json({ error: 'A valid email is required' });
    }

    // No users yet → this is a fresh install; first account must go through setup.
    const userCount = await prisma.user.count();
    if (userCount === 0) {
      return res.status(403).json({ error: 'Complete initial setup before creating accounts.' });
    }

    const registrationEnabled = await getBoolSetting('registration_enabled', true);
    if (!registrationEnabled) {
      return res.status(403).json({ error: 'Registration is currently disabled.' });
    }

    // Assign the configured default plan when one is set and exists.
    let planId: string | null = null;
    const defaultPlanKey = await getSetting('default_plan_key');
    if (defaultPlanKey) {
      const plan = await prisma.plan.findFirst({ where: { key: defaultPlanKey } });
      planId = plan?.id ?? null;
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const now = new Date();

    const user = await prisma.user.create({
      data: {
        name: String(name).trim(),
        email: emailNorm,
        password: hashedPassword,
        role: 'user',
        status: 'active',
        plan_id: planId,
        passwordChangedAt: now,
      },
    });

    // Best-effort signup audit (actor is the new user).
    try {
      (req as any).user = { userId: user.id, email: user.email, role: user.role };
      await writeAudit(req, 'user.signup', `user:${user.id}`, { email: user.email });
    } catch {
      /* never block signup on audit */
    }

    const token = signSessionToken(user);
    res.status(201).json({
      message: 'Signup successful',
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'Email already exists' });
    }
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Signup failed' });
  }
});

/** Failed attempts before the account is locked, and for how long (spec §2). */
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

// Login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (!user) {
      // Recorded even though no such account exists: a run of `unknown_user` rows
      // against `admin@` is exactly what the security page exists to show.
      await recordLoginAttempt(req, email, 'unknown_user');
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Locked out by earlier failures. Checked before the password compare so a
    // lockout cannot be brute-forced through, and the remaining time is stated —
    // "try again later" with no number reads as a permanent ban.
    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      const minutes = Math.max(1, Math.ceil((user.locked_until.getTime() - Date.now()) / 60000));
      await recordLoginAttempt(req, email, 'locked');
      return res.status(423).json({
        error: `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      await recordLoginAttempt(req, email, 'bad_password');
      // Count the failure and lock the account once the threshold is crossed.
      const failed = user.failed_logins + 1;
      const lock = failed >= MAX_FAILED_LOGINS;
      await prisma.user
        .update({
          where: { id: user.id },
          data: {
            failed_logins: lock ? 0 : failed,
            locked_until: lock ? new Date(Date.now() + LOCKOUT_MS) : null,
          },
        })
        .catch(() => undefined);
      if (lock) {
        (req as any).user = { userId: user.id, email: user.email, role: user.role };
        await writeAudit(req, 'auth.locked', {
          target_type: 'user',
          target_id: user.id,
          target_label: user.email,
          severity: 'warning',
          metadata: { failed_attempts: failed, minutes: LOCKOUT_MS / 60000 },
        });
        return res.status(423).json({
          error: `Too many failed sign-in attempts. Try again in ${LOCKOUT_MS / 60000} minutes.`,
        });
      }
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Status gates. `authMiddleware` already refuses a suspended account on every
    // authenticated request, but issuing a token first and failing afterwards
    // showed the user a working sign-in followed by errors on every page. Refuse
    // here, with the reason, and never mint the token.
    if (user.status === 'suspended') {
      await recordLoginAttempt(req, email, 'suspended');
      return res.status(403).json({ error: 'Account suspended. Contact an administrator.' });
    }
    if (user.status === 'pending') {
      await recordLoginAttempt(req, email, 'pending');
      return res
        .status(403)
        .json({ error: 'Your account is awaiting administrator approval.' });
    }

    const token = await issueSession(req, user);
    await recordLoginAttempt(req, email, 'ok');

    // Record the sign-in. `last_login_ip` is what the admin header shows an
    // operator so an address they do not recognise is visible as a compromise.
    const ip = clientIp(req as any);
    await prisma.user
      .update({
        where: { id: user.id },
        data: {
          last_login_at: new Date(),
          last_login_ip: ip,
          login_count: { increment: 1 },
          failed_logins: 0,
          locked_until: null,
        },
      })
      .catch(() => undefined);

    // Operator sign-ins are audited; customer sign-ins are not, or the table
    // becomes a traffic log and the actual administrative actions drown in it.
    if (hasAdminAccess(user.role)) {
      (req as any).user = { userId: user.id, email: user.email, role: user.role };
      await writeAudit(req, 'admin.login', {
        target_type: 'user',
        target_id: user.id,
        target_label: user.email,
        severity: 'info',
        metadata: { role: user.role, ip },
      });
    }

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error: any) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get current user (requires auth)
router.get('/me', authMiddleware, async (req: Request, res: Response) => {
  try {
    const authUser = (req as any).user;

    const user = await prisma.user.findUnique({
      where: { id: authUser.userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        created_at: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (error: any) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// Update profile (name, email)
router.patch('/profile', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { name, email } = req.body;
    const authUser = (req as any).user;

    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }

    const updatedUser = await prisma.user.update({
      where: { id: authUser.userId },
      data: {
        name,
        email: email.toLowerCase(),
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
      },
    });

    res.json({ message: 'Profile updated', user: updatedUser });
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'Email already exists' });
    }
    console.error('Profile update error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Change password — invalidates existing JWTs via passwordChangedAt
router.post('/change-password', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const authUser = (req as any).user;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new passwords are required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const user = await prisma.user.findUnique({
      where: { id: authUser.userId },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      return res.status(400).json({ error: 'Invalid current password' });
    }

    const hashedNewPassword = await bcrypt.hash(newPassword, 12);
    const now = new Date();
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { password: hashedNewPassword, passwordChangedAt: now },
    });

    // Every token minted before this moment is already dead (`pwdv`), so the
    // session rows are marked to match — a sessions page still listing them as live
    // would be reporting the opposite of what the middleware does.
    await revokeSessionsForUser(user.id, 'password_change');

    // Issue a fresh session so the current client stays logged in
    const token = await issueSession(req, updated);

    res.json({ message: 'Password changed successfully', token });
  } catch (error: any) {
    console.error('Password change error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// ========================================
// Setup Token (for restore-upload on fresh install)
// ========================================

// GET /api/auth/setup-token — pre-first-user only. Gated by the bootstrap secret
// when one is required; otherwise open for the same reason /register is (a fresh
// install with no console must still be restorable).
router.get('/setup-token', async (req: Request, res: Response) => {
  try {
    const userCount = await prisma.user.count();
    if (userCount > 0) {
      return res.status(403).json({ error: 'Setup already complete. Setup tokens are only available before first user registration.' });
    }

    if (isBootstrapRequired() && !requireBootstrap(req, res)) return;

    const tokenPath = path.join(config.dataPath, '.setup-token');

    if (!fs.existsSync(tokenPath)) {
      fs.mkdirSync(config.dataPath, { recursive: true });
      const token = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(tokenPath, token, { mode: 0o600 });
    }

    const token = fs.readFileSync(tokenPath, 'utf8').trim();
    res.json({ setupToken: token });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to generate setup token' });
  }
});

// ========================================
// Short-lived purpose tokens (SSE / terminal query params)
// ========================================

router.post('/sse-token', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const dbUser = await prisma.user.findUnique({
      where: { id: user.userId },
      select: { passwordChangedAt: true },
    });
    const pwdv = dbUser?.passwordChangedAt?.getTime() ?? 0;

    const sseToken = jwt.sign(
      {
        userId: user?.userId,
        email: user?.email,
        role: user?.role,
        purpose: 'sse',
        pwdv,
      },
      JWT_SECRET,
      { expiresIn: '5m' }
    );

    res.json({ token: sseToken });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to generate SSE token' });
  }
});

// POST /api/auth/terminal-token — short-lived WS upgrade token (not the 7d session JWT)
//
// Full admins only. The shell this token buys is root inside the panel container,
// which mounts the host Docker socket — so a plain customer holding one could run
// `docker` against the host engine and reach every other tenant's data. The
// interactive password step in services/terminal.ts is NOT a second factor here:
// the user knows their own password. This is the gate.
router.post('/terminal-token', authMiddleware, requireAdmin, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const dbUser = await prisma.user.findUnique({
      where: { id: user.userId },
      select: { passwordChangedAt: true },
    });
    const pwdv = dbUser?.passwordChangedAt?.getTime() ?? 0;

    const terminalToken = jwt.sign(
      {
        userId: user?.userId,
        email: user?.email,
        role: user?.role,
        purpose: 'terminal',
        pwdv,
      },
      JWT_SECRET,
      { expiresIn: '5m' }
    );

    res.json({ token: terminalToken });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to generate terminal token' });
  }
});

export default router;
