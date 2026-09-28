// Check-digit validation for public security identifiers. A holding that
// carries a *valid* ISIN or CUSIP is publicly identified; placeholders are
// not. Real filings put junk in these fields for private holdings:
// Innovation Access Fund's Anthropic row has ISIN "N/A"; KraneShares' has
// ticker "1892140D" and no ISIN/CUSIP; dummy CUSIPs like 000000000 and
// 999999999 are common. Tickers are free text with no check digit, so they
// are never treated as proof that a holding is public.

const CUSIP_SPECIAL = { '*': 36, '@': 37, '#': 38 };

function cusipCharValue(ch) {
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
  if (ch >= 'A' && ch <= 'Z') return ch.charCodeAt(0) - 55; // A=10 … Z=35
  return CUSIP_SPECIAL[ch];
}

function isValidCusip(value) {
  const c = String(value ?? '')
    .trim()
    .toUpperCase();
  if (!/^[0-9A-Z*@#]{8}[0-9]$/.test(c)) return false;
  if (/^(.)\1{8}$/.test(c)) return false; // 000000000, 999999999, …
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    let v = cusipCharValue(c[i]);
    if (i % 2 === 1) v *= 2;
    sum += Math.floor(v / 10) + (v % 10);
  }
  return (10 - (sum % 10)) % 10 === Number(c[8]);
}

function isValidIsin(value) {
  const s = String(value ?? '')
    .trim()
    .toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(s)) return false;
  // Letters expand to two digits (A=10 … Z=35), then Luhn over the payload.
  let digits = '';
  for (const ch of s.slice(0, 11)) digits += ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let v = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) v *= 2;
    sum += Math.floor(v / 10) + (v % 10);
  }
  return (10 - (sum % 10)) % 10 === Number(s[11]);
}

module.exports = { isValidCusip, isValidIsin };
