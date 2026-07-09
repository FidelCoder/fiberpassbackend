import { config, helpers, utils } from '@ckb-lumos/lumos';
import { env } from '../config/env.js';

export type VaultHashType = 'data' | 'type' | 'data1' | 'data2';
export type VaultOwnerLockHashSource = 'wallet-id-derived' | 'user-lock-hash';

export interface DerivedVaultDto {
  address: string;
  scriptHash: string;
  script: {
    codeHash: string;
    hashType: VaultHashType;
    args: string;
  };
  accountIdHash: string;
  vaultIdHash: string;
  ownerLockHash: string;
  ownerLockHashSource: VaultOwnerLockHashSource;
  operatorLockHash: string;
}

export interface VaultRuntimeConfigDto {
  configured: boolean;
  network: string;
  codeHash: string;
  hashType: VaultHashType;
  operatorLockHash: string;
}

const SCRIPT_VERSION = 1;

function isHex(value: string, bytes?: number): boolean {
  const pattern = bytes == null ? /^0x[0-9a-fA-F]+$/ : new RegExp('^0x[0-9a-fA-F]{' + bytes * 2 + '}$');
  return pattern.test(value);
}

function stripHex(value: string): string {
  return value.startsWith('0x') ? value.slice(2) : value;
}

function ckbHash(value: string): string {
  return utils.ckbHash(Buffer.from(value));
}

function concatHex(...values: string[]): string {
  return '0x' + values.map(stripHex).join('');
}

function byteHex(value: number): string {
  return value.toString(16).padStart(2, '0');
}

function networkConfig() {
  return env.FIBER_NETWORK.toLowerCase().includes('main') ? config.MAINNET : config.TESTNET;
}

function hashType(): VaultHashType {
  return env.FIBERPASS_VAULT_HASH_TYPE as VaultHashType;
}

export function getVaultRuntimeConfig(): VaultRuntimeConfigDto {
  const codeHash = env.FIBERPASS_VAULT_CODE_HASH;
  const operatorLockHash = env.FIBERPASS_OPERATOR_LOCK_HASH;
  const configured = isHex(codeHash, 32) && isHex(operatorLockHash, 32);

  return {
    configured,
    network: env.FIBER_NETWORK,
    codeHash,
    hashType: hashType(),
    operatorLockHash
  };
}

export function deriveAccountIdHash(walletId: string): string {
  return ckbHash('fiberpass:account:' + walletId);
}

export function deriveWalletOwnerLockHash(walletId: string): string {
  return ckbHash('fiberpass:owner:' + walletId);
}

export function deriveVaultIdHash(accountIdHash: string): string {
  return ckbHash('fiberpass:vault:' + accountIdHash);
}


export function minimalVaultCellCapacityShannons(script: DerivedVaultDto['script']): number {
  const cell = {
    cellOutput: {
      capacity: '0x0',
      lock: script,
      type: undefined
    },
    data: '0x'
  } as Parameters<typeof helpers.minimalCellCapacity>[0];
  const capacity = Number(helpers.minimalCellCapacity(cell));
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new Error('Unable to calculate safe minimum vault cell capacity.');
  }
  return capacity;
}

export function deriveVaultForWallet(input: { walletId: string; ownerLockHash?: string }): DerivedVaultDto | null {
  const runtime = getVaultRuntimeConfig();
  if (!runtime.configured) return null;

  const accountIdHash = deriveAccountIdHash(input.walletId);
  const vaultIdHash = deriveVaultIdHash(accountIdHash);
  const ownerLockHash = input.ownerLockHash && isHex(input.ownerLockHash, 32)
    ? input.ownerLockHash
    : deriveWalletOwnerLockHash(input.walletId);
  const ownerLockHashSource: VaultOwnerLockHashSource = input.ownerLockHash && isHex(input.ownerLockHash, 32)
    ? 'user-lock-hash'
    : 'wallet-id-derived';
  const args = concatHex(
    byteHex(SCRIPT_VERSION),
    vaultIdHash,
    ownerLockHash,
    runtime.operatorLockHash
  );
  const script = {
    codeHash: runtime.codeHash,
    hashType: runtime.hashType,
    args
  };

  return {
    address: helpers.encodeToAddress(script, { config: networkConfig() }),
    scriptHash: utils.computeScriptHash(script),
    script,
    accountIdHash,
    vaultIdHash,
    ownerLockHash,
    ownerLockHashSource,
    operatorLockHash: runtime.operatorLockHash
  };
}
