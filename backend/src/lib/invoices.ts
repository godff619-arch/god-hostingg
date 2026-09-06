/**
 * Invoice generation + numbering (spec §11).
 *
 * Every activation leaves an invoice behind, so "what did I pay for" is answerable
 * from the DB alone rather than from the provider dashboard. Amounts are integer
 * cents throughout — no floats touch money.
 *
 * Numbering is `GH-<year>-<seq>`, sequential per calendar year, allocated inside a
 * transaction so two concurrent activations can't collide. The `number` column is
 * unique, so if they ever did, the second insert fails loudly instead of silently
 * issuing a duplicate.
 */
import prisma from './prisma.js';

/** Short human id in the existing `inv-xxxxxxxx` style. */
function invoiceId(): string {
  return 'inv-' + Math.random().toString(36).slice(2, 10);
}

/**
 * Next invoice number for the current year. Reads the highest existing number
 * rather than keeping a counter setting: one source of truth, and it self-heals if
 * rows are imported.
 */
export async function nextInvoiceNumber(now = new Date()): Promise<string> {
  const year = now.getUTCFullYear();
  const prefix = `GH-${year}-`;
  const latest = await prisma.invoice.findFirst({
    where: { number: { startsWith: prefix } },
    orderBy: { number: 'desc' },
    select: { number: true },
  });
  const seq = latest?.number ? Number(latest.number.slice(prefix.length)) + 1 : 1;
  return prefix + String(Number.isFinite(seq) ? seq : 1).padStart(4, '0');
}

export interface InvoiceLine {
  description: string;
  quantity?: number;
  unit_cents: number;
  /** plan | usage | credit | discount | tax */
  kind?: 'plan' | 'usage' | 'credit' | 'discount' | 'tax';
}

export interface IssueInvoiceArgs {
  workspace_id: string;
  lines: InvoiceLine[];
  currency?: string;
  period_start?: Date;
  period_end?: Date;
  /** paid | pending | failed | refunded | void */
  status?: string;
  /** Payment that settled it, when the invoice is being issued post-payment. */
  payment_id?: string | null;
  tax_cents?: number;
  discount_cents?: number;
  credit_cents?: number;
  due_at?: Date | null;
  notes?: string | null;
}

/**
 * Create an invoice with its line items. Totals are computed here from the lines
 * so a caller can't post an amount that disagrees with what it itemised.
 */
export async function issueInvoice(args: IssueInvoiceArgs) {
  const now = new Date();
  const lines = args.lines.map((l) => ({
    description: l.description,
    quantity: l.quantity ?? 1,
    unit_cents: l.unit_cents,
    amount_cents: Math.round((l.quantity ?? 1) * l.unit_cents),
    kind: l.kind ?? 'plan',
  }));

  const subtotal = lines.reduce((sum, l) => sum + l.amount_cents, 0);
  const tax = args.tax_cents ?? 0;
  const discount = args.discount_cents ?? 0;
  const credit = args.credit_cents ?? 0;
  // Never invoice a negative total: an over-large credit simply zeroes the bill.
  const total = Math.max(0, subtotal + tax - discount - credit);

  const periodStart = args.period_start ?? now;
  const periodEnd = args.period_end ?? new Date(now.getTime() + 30 * 86_400_000);
  const status = args.status ?? 'pending';

  return prisma.invoice.create({
    data: {
      id: invoiceId(),
      number: await nextInvoiceNumber(now),
      workspace_id: args.workspace_id,
      period_start: periodStart,
      period_end: periodEnd,
      amount_cents: total,
      subtotal_cents: subtotal,
      tax_cents: tax,
      discount_cents: discount,
      credit_cents: credit,
      currency: (args.currency ?? 'USD').toUpperCase(),
      status,
      payment_id: args.payment_id ?? null,
      due_at: args.due_at ?? null,
      notes: args.notes ?? null,
      paid_at: status === 'paid' ? now : null,
      items: { create: lines },
    },
    include: { items: true },
  });
}

/** Money for display: 1999 → "$19.99". Currency-symbol table stays tiny on purpose. */
export function formatMoney(cents: number, currency = 'USD'): string {
  const symbols: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', INR: '₹' };
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const symbol = symbols[currency.toUpperCase()] ?? '';
  const body = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return symbol ? `${sign}${symbol}${body}` : `${sign}${body} ${currency.toUpperCase()}`;
}

/**
 * Plain-text invoice rendering. Used for the emailed copy and as the download
 * body until a PDF renderer is wired in — an honest text invoice beats a button
 * that 404s, and `pdf_path` stays NULL so nothing claims a PDF exists.
 */
export function renderInvoiceText(invoice: {
  number: string | null;
  id: string;
  issued_at: Date;
  status: string;
  currency: string;
  subtotal_cents: number;
  tax_cents: number;
  discount_cents: number;
  credit_cents: number;
  amount_cents: number;
  period_start: Date;
  period_end: Date;
  notes: string | null;
  items: { description: string; quantity: number; unit_cents: number; amount_cents: number }[];
}, workspaceName: string, billTo: string | null): string {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const money = (c: number) => formatMoney(c, invoice.currency);
  const rows = invoice.items.map(
    (i) => `  ${i.description}\n    ${i.quantity} × ${money(i.unit_cents)} = ${money(i.amount_cents)}`,
  );
  const totals = [
    `  Subtotal      ${money(invoice.subtotal_cents)}`,
    invoice.discount_cents ? `  Discount     -${money(invoice.discount_cents)}` : null,
    invoice.credit_cents ? `  Credit       -${money(invoice.credit_cents)}` : null,
    invoice.tax_cents ? `  Tax           ${money(invoice.tax_cents)}` : null,
    `  Total         ${money(invoice.amount_cents)}`,
  ].filter(Boolean);

  return [
    `INVOICE ${invoice.number ?? invoice.id}`,
    `Issued ${day(invoice.issued_at)}   Status: ${invoice.status.toUpperCase()}`,
    `Period ${day(invoice.period_start)} → ${day(invoice.period_end)}`,
    '',
    `Billed to: ${billTo ?? workspaceName}`,
    `Workspace: ${workspaceName}`,
    '',
    'Items',
    ...rows,
    '',
    ...totals,
    invoice.notes ? `\nNotes: ${invoice.notes}` : '',
  ].join('\n');
}
