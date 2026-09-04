// Primary Account Number (PAN) detection — a guard, not a validator.
//
// The billing endpoints deliberately store card *metadata* only (brand, last four,
// expiry) plus whatever opaque reference the payment provider handed back. A real
// card number must never reach the database, so submissions are screened before
// they are written.
//
// Screening has to be precise in both directions. "Reject anything with a long run
// of digits" does stop a pasted card number, but it also rejects the perfectly
// legitimate all-numeric tokens some providers issue — and an operator whose valid
// token is refused has no way to tell the difference from a bug. So the test is the
// actual shape of a PAN: 12–19 digits (12 covers short Maestro ranges, 19 the long
// UnionPay/Maestro ones) that satisfy the Luhn checksum.
//
// Trade-off, stated plainly: an arbitrary 12–19 digit token passes Luhn about one
// time in ten and will be refused. That is the deliberate direction to err, and the
// error message tells the operator what to do about it. Conversely a *mistyped* card
// number fails Luhn and slips through — the accident actually worth stopping is a
// copy-paste of a real card, which always checksums.

/** Luhn (mod-10) checksum over a digits-only string. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Whether `value` contains something that is very probably a real card number.
 *
 * Each maximal run of digits (spaces and dashes tolerated inside it, since that is
 * how humans paste cards) is considered on its own. Only a run whose whole digit
 * length lands in 12–19 is tested, so a longer numeric token is not screened by its
 * prefix — `4111111111111111` is caught, a 24-digit provider reference is not.
 */
export function looksLikeCardNumber(value: string): boolean {
  if (!value) return false;
  for (const chunk of value.split(/[^\d \-]+/)) {
    const digits = chunk.replace(/\D/g, '');
    if (digits.length < 12 || digits.length > 19) continue;
    if (luhnValid(digits)) return true;
  }
  return false;
}
