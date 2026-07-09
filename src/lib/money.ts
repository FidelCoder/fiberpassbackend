export const DEFAULT_CURRENCY = 'CKB';

export interface CurrencyMetadata {
  code: string;
  decimals: number;
  symbol: string;
}

export const CURRENCY_METADATA: Record<string, CurrencyMetadata> = {
  USDC: { code: 'USDC', decimals: 6, symbol: '$' },
  CKB: { code: 'CKB', decimals: 8, symbol: 'CKB' }
};

export function getCurrencyMetadata(currency: string = DEFAULT_CURRENCY): CurrencyMetadata {
  const metadata = CURRENCY_METADATA[currency.toUpperCase()];
  if (!metadata) {
    throw new Error('Unsupported currency: ' + currency);
  }
  return metadata;
}

function decimalString(value: number | string): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Money amount must be finite.');
    return value.toString();
  }
  return value.trim();
}

export function toMinorUnits(value: number | string, currency: string = DEFAULT_CURRENCY): number {
  const { decimals } = getCurrencyMetadata(currency);
  const raw = decimalString(value);
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error('Money amount must be a non-negative decimal string.');
  }

  const [whole, fraction = ''] = raw.split('.');
  const padded = (fraction + '0'.repeat(decimals)).slice(0, decimals);
  const extra = fraction.slice(decimals);
  if (extra.length > 0 && /[1-9]/.test(extra)) {
    throw new Error(currency + ' supports at most ' + decimals + ' decimal places.');
  }

  const minor = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || '0');
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Money amount exceeds safe integer range.');
  }
  return Number(minor);
}

export function fromMinorUnits(minorUnits: number | undefined | null, currency: string = DEFAULT_CURRENCY): number {
  if (minorUnits == null) return 0;
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0) {
    throw new Error('Minor-unit amount must be a non-negative safe integer.');
  }

  const { decimals } = getCurrencyMetadata(currency);
  return minorUnits / 10 ** decimals;
}

export function fallbackMinorUnits(minorUnits: number | undefined | null, majorAmount: number | undefined | null, currency: string = DEFAULT_CURRENCY): number {
  if (Number.isSafeInteger(minorUnits) && (minorUnits ?? 0) >= 0) return minorUnits as number;
  return toMinorUnits(String(majorAmount ?? 0), currency);
}

export function addMinorUnits(...values: number[]): number {
  return values.reduce((total, value) => {
    if (!Number.isSafeInteger(value)) throw new Error('Minor-unit amount must be a safe integer.');
    return total + value;
  }, 0);
}

export function subtractMinorUnits(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
    throw new Error('Minor-unit amount must be a safe integer.');
  }
  return left - right;
}

export function clampMinorUnits(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error('Minor-unit amount must be a safe integer.');
  return Math.max(0, value);
}

export function roundMoney(value: number): number {
  return fromMinorUnits(toMinorUnits(String(Math.max(0, value))));
}
