/**
 * Boot-time invariant: the platform always has exactly one OWNER (the untouchable
 * root of the admin-tier hierarchy — see lib/platformRoles.ts).
 *
 * Why this exists: fresh installs mint an owner at bootstrap (auth.ts /register),
 * but a *legacy* database predates tiers — every operator is role:'admin' and
 * none is owner. A restored backup can be in the same state. Without a root, no
 * one could ever be granted super-admin (canAssignRole needs an actor ranked
 * above the role it grants), so the tier system would be inert.
 *
 * The reconciliation is deliberately minimal and idempotent: if an owner already
 * exists it does nothing; otherwise it promotes the OLDEST privileged account
 * (falling back to the oldest account of any kind) to owner. It only ever *adds*
 * authority to the most senior existing operator — it never demotes or deletes,
 * so it cannot lock anyone out or destroy data.
 */
import prisma from './prisma.js';

export async function ensureOwnerExists(): Promise<void> {
  try {
    const existingOwner = await prisma.user.findFirst({ where: { role: 'owner' } });
    if (existingOwner) return;

    // Prefer the most senior operator; fall back to the oldest account overall.
    const candidate =
      (await prisma.user.findFirst({
        where: { role: { in: ['super_admin', 'admin'] } },
        orderBy: { created_at: 'asc' },
      })) ?? (await prisma.user.findFirst({ orderBy: { created_at: 'asc' } }));

    if (!candidate) return; // fresh install, no users yet — bootstrap will mint the owner

    await prisma.user.update({ where: { id: candidate.id }, data: { role: 'owner' } });
    console.log(`[rbac] Promoted ${candidate.email} to owner (no owner existed)`);
  } catch (err) {
    // Non-fatal: a DB hiccup here must not stop the server from booting. The gate
    // still works (full admins keep working); reconciliation retries next boot.
    console.warn('[rbac] ensureOwnerExists skipped:', (err as Error)?.message);
  }
}
