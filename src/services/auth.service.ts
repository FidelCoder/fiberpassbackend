import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getAddress, verifyMessage } from 'ethers';
import { env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';
import { AuthChallengeModel, AuthSessionModel } from '../models/auth.model.js';
import { writeAuditLog } from './audit.service.js';
import type { AuthContext } from '../types/auth.js';
import { ensureWalletForAddress, walletIdFromAddress, type WalletDto } from './session.service.js';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AuthChallengeDto {
  challengeId: string;
  message: string;
  expiresAt: string;
  network: string;
}

export interface AuthVerifyInput {
  challengeId: string;
  address: string;
  signature: string;
}

export interface AuthVerifyDto {
  token: string;
  expiresAt: string;
  wallet: WalletDto;
}

function normalizeAddress(address: string): string {
  try {
    return getAddress(address);
  } catch {
    throw new ApiError(400, 'INVALID_WALLET_ADDRESS', 'JoyID returned an invalid EVM wallet address.');
  }
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function buildChallengeMessage(input: { address?: string; nonce: string; issuedAt: Date; expiresAt: Date }): string {
  return [
    'FiberPass JoyID Login',
    '',
    'Approve this signature to authenticate with FiberPass.',
    `Wallet: ${input.address ?? 'JoyID wallet'}`,
    `Fiber Network: ${env.FIBER_NETWORK}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt.toISOString()}`,
    `Expires At: ${input.expiresAt.toISOString()}`
  ].join('\n');
}

export async function createAuthChallenge(address?: string): Promise<AuthChallengeDto> {
  const normalizedAddress = address ? normalizeAddress(address) : undefined;
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
  const nonce = randomBytes(16).toString('hex');
  const message = buildChallengeMessage({ address: normalizedAddress, nonce, issuedAt, expiresAt });
  const challengeId = randomUUID();

  await AuthChallengeModel.create({
    challengeId,
    address: normalizedAddress,
    message,
    nonce,
    expiresAt
  });

  return {
    challengeId,
    message,
    expiresAt: expiresAt.toISOString(),
    network: env.FIBER_NETWORK
  };
}

export async function verifyAuthChallenge(input: AuthVerifyInput): Promise<AuthVerifyDto> {
  const normalizedAddress = normalizeAddress(input.address);
  const challenge = await AuthChallengeModel.findOne({ challengeId: input.challengeId });

  if (!challenge) {
    throw new ApiError(404, 'AUTH_CHALLENGE_NOT_FOUND', 'Login challenge was not found or has expired.');
  }

  if (challenge.consumedAt) {
    throw new ApiError(409, 'AUTH_CHALLENGE_USED', 'Login challenge has already been used.');
  }

  if (challenge.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(410, 'AUTH_CHALLENGE_EXPIRED', 'Login challenge has expired.');
  }

  if (challenge.address && normalizeAddress(challenge.address) !== normalizedAddress) {
    throw new ApiError(401, 'AUTH_ADDRESS_MISMATCH', 'Signed wallet address does not match the requested JoyID address.');
  }

  let recoveredAddress: string;
  try {
    recoveredAddress = getAddress(verifyMessage(challenge.message, input.signature));
  } catch {
    throw new ApiError(401, 'AUTH_SIGNATURE_INVALID', 'JoyID signature could not be verified.');
  }

  if (recoveredAddress !== normalizedAddress) {
    throw new ApiError(401, 'AUTH_SIGNATURE_MISMATCH', 'JoyID signature does not match the connected wallet.');
  }

  challenge.consumedAt = new Date();
  await challenge.save();

  const wallet = await ensureWalletForAddress(normalizedAddress);
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await AuthSessionModel.create({
    tokenHash: tokenHash(token),
    walletId: wallet.walletId,
    address: normalizedAddress,
    expiresAt
  });

  await writeAuditLog({
    actorWalletId: wallet.walletId,
    actorAddress: normalizedAddress,
    action: 'auth.login',
    targetType: 'wallet',
    targetId: wallet.walletId,
    metadata: { challengeId: input.challengeId }
  });

  return {
    token,
    expiresAt: expiresAt.toISOString(),
    wallet: {
      connected: true,
      address: normalizedAddress,
      authProvider: 'joyid',
      addressType: 'evm',
      balance: wallet.balance,
      balanceMinor: wallet.balanceMinor ?? Math.round(wallet.balance * 1_000_000),
      currency: wallet.currency
    }
  };
}

export async function getAuthContextFromToken(token: string): Promise<AuthContext> {
  const session = await AuthSessionModel.findOne({
    tokenHash: tokenHash(token),
    expiresAt: { $gt: new Date() }
  }).lean();

  if (!session) {
    throw new ApiError(401, 'AUTH_SESSION_INVALID', 'JoyID session is invalid or expired.');
  }

  return {
    walletId: session.walletId,
    address: session.address
  };
}

export async function revokeAuthToken(token: string): Promise<void> {
  const session = await AuthSessionModel.findOneAndDelete({ tokenHash: tokenHash(token) });
  if (session) {
    await writeAuditLog({
      actorWalletId: session.walletId,
      actorAddress: session.address,
      action: 'auth.logout',
      targetType: 'wallet',
      targetId: session.walletId
    });
  }
}

export async function getWalletForAuthContext(auth: AuthContext): Promise<{ wallet: WalletDto }> {
  const wallet = await ensureWalletForAddress(auth.address);
  return {
    wallet: {
      connected: true,
      address: wallet.address,
      authProvider: 'joyid',
      addressType: 'evm',
      balance: wallet.balance,
      balanceMinor: wallet.balanceMinor ?? Math.round(wallet.balance * 1_000_000),
      currency: wallet.currency
    }
  };
}
