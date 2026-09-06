/**
 * Credit / wallet ledger (spec §13).
 *
 * "Every credit modification requires: Admin ID, Amount, Reason, Timestamp. Never
 * silently modify balances."
 *
 * So `credit_balances.balance_cents` is treated as a cache, and every movement goes
 * through `moveCredit()`, which writes the `CreditTransaction` row and the new
 * balance in one transaction. Nothing else in the codebase writes that column —
 * that is what makes the ledger trustworthy rather than decorative.
 */
import prisma from './prisma.js';

export type CreditKind = 'grant' | 'revoke' | 'promo' | 'refund' | 'usage' | 'adjustment';

export interface CreditMoveArgs {
  workspace_id: string;
  /** Signed cents: positive grants, negative consumes/revokes. */
  amount_cents: number;
  kind?: CreditKind;
  reason: string;
  /** Admin who moved it. NULL for automated movements (promo, usage debit). */
  admin_id?: string | null;
}

export interface CreditMoveResult {
  ok: boolean;
  detail?: string;
  balance_cents?: number;
  transaction_id?: string;
}

/** Current balance, creating the row lazily. */
export async function creditBalance(workspaceId: string): Promise<number> {
  const row = await prisma.creditBalance.findUnique({ where: { workspace_id: workspaceId } });
  return row?.balance_cents ?? 0;
}

/**
 * Move the balance and record why. Refuses a zero move (nothing to audit), a
 * missing reason, and any debit that would push the balance negative — a wallet
 * that can go below zero is an unbilled loan.
 */
export async function moveCredit(args: CreditMoveArgs): Promise<CreditMoveResult> {
  const reason = args.reason?.trim();
  if (!reason) return { ok: false, detail: 'a reason is required for every credit change' };

  const amount = Math.round(args.amount_cents);
  if (!Number.isFinite(amount) || amount === 0) {
    return { ok: false, detail: 'amount must be a non-zero number of cents' };
  }

  const current = await creditBalance(args.workspace_id);
  const next = current + amount;
  if (next < 0) {
    return { ok: false, detail: `insufficient credit: balance ${current}, requested ${amount}` };
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.creditBalance.upsert({
      where: { workspace_id: args.workspace_id },
      update: { balance_cents: next, updated_at: new Date() },
      create: { workspace_id: args.workspace_id, balance_cents: next },
    });
    return tx.creditTransaction.create({
      data: {
        workspace_id: args.workspace_id,
        amount_cents: amount,
        kind: args.kind ?? (amount > 0 ? 'grant' : 'revoke'),
        reason,
        admin_id: args.admin_id ?? null,
        balance_after: next,
      },
    });
  });

  return { ok: true, balance_cents: next, transaction_id: result.id };
}

/**
 * Apply available credit to an amount due. Returns how much credit to put on the
 * invoice and leaves the debit in the ledger. Callers pass the *gross* amount and
 * charge the remainder.
 */
export async function applyCreditToCharge(args: {
  workspace_id: string;
  amount_cents: number;
  description: string;
}): Promise<{ credit_applied_cents: number; charge_cents: number }> {
  const balance = await creditBalance(args.workspace_id);
  if (balance <= 0) return { credit_applied_cents: 0, charge_cents: args.amount_cents };

  const applied = Math.min(balance, args.amount_cents);
  if (applied <= 0) return { credit_applied_cents: 0, charge_cents: args.amount_cents };

  await moveCredit({
    workspace_id: args.workspace_id,
    amount_cents: -applied,
    kind: 'usage',
    reason: args.description,
  });
  return { credit_applied_cents: applied, charge_cents: args.amount_cents - applied };
}
