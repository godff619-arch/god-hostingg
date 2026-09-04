import test from 'node:test';
import assert from 'node:assert/strict';
import { luhnValid, looksLikeCardNumber } from './pan.js';

test('luhnValid accepts the standard test PANs', () => {
  for (const pan of [
    '4111111111111111', // Visa
    '5555555555554444', // Mastercard
    '378282246310005', // Amex (15)
    '6011111111111117', // Discover
    '3530111333300000', // JCB
  ]) {
    assert.equal(luhnValid(pan), true, pan);
  }
});

test('luhnValid rejects a mistyped PAN and non-digits', () => {
  assert.equal(luhnValid('4111111111111112'), false);
  assert.equal(luhnValid('pm_123'), false);
  assert.equal(luhnValid(''), false);
});

test('looksLikeCardNumber catches a pasted card, with or without separators', () => {
  assert.equal(looksLikeCardNumber('4111111111111111'), true);
  assert.equal(looksLikeCardNumber('4111 1111 1111 1111'), true);
  assert.equal(looksLikeCardNumber('4111-1111-1111-1111'), true);
  assert.equal(looksLikeCardNumber('card is 5555555555554444 ok'), true);
  // Inside a stringified request body, which is how the endpoint screens it.
  assert.equal(
    looksLikeCardNumber(JSON.stringify({ provider_ref: '4111111111111111', last4: '1111' })),
    true,
  );
});

test('looksLikeCardNumber lets legitimate provider tokens through', () => {
  // Stripe-style opaque references.
  assert.equal(looksLikeCardNumber('pm_1NXabcDEfghIJklMNopQRstu'), false);
  assert.equal(looksLikeCardNumber('tok_visa'), false);
  // The all-numeric token from the reported false positive: 12 digits, fails Luhn.
  assert.equal(looksLikeCardNumber('602822534520'), false);
  // A long numeric reference must not be judged by a 19-digit prefix.
  assert.equal(looksLikeCardNumber('411111111111111102938475610293'), false);
  // Metadata-only body: last four, expiry, brand.
  assert.equal(
    looksLikeCardNumber(
      JSON.stringify({ provider_ref: 'pm_1NXabc', brand: 'Visa', last4: '5426', exp_year: 2028 }),
    ),
    false,
  );
});

test('looksLikeCardNumber ignores runs outside PAN length', () => {
  assert.equal(looksLikeCardNumber('42424242424'), false); // 11 digits
  assert.equal(looksLikeCardNumber('1'.repeat(25)), false);
  assert.equal(looksLikeCardNumber(''), false);
});
