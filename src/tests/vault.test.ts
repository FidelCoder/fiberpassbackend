import assert from 'node:assert/strict';

process.env.FIBER_NETWORK = 'testnet';
process.env.FIBERPASS_VAULT_CODE_HASH = '0x' + '11'.repeat(32);
process.env.FIBERPASS_VAULT_HASH_TYPE = 'type';
process.env.FIBERPASS_OPERATOR_LOCK_HASH = '0x' + '22'.repeat(32);

const { deriveVaultForWallet, getVaultRuntimeConfig, minimalVaultCellCapacityShannons } = await import('../services/vault.service.js');

const runtime = getVaultRuntimeConfig();
assert.equal(runtime.configured, true);
assert.equal(runtime.network, 'testnet');

const firstVault = deriveVaultForWallet({ walletId: '0xuser-one' });
const secondVault = deriveVaultForWallet({ walletId: '0xuser-two' });
assert.ok(firstVault);
assert.ok(secondVault);
assert.match(firstVault.address, /^ckt1/);
assert.match(secondVault.address, /^ckt1/);
assert.notEqual(firstVault.address, secondVault.address);
assert.equal(firstVault.script.args.length, 2 + 97 * 2);
assert.equal(firstVault.ownerLockHashSource, 'wallet-id-derived');
assert.equal(minimalVaultCellCapacityShannons(firstVault.script), 13_800_000_000);

const ownerLockHash = '0x' + '33'.repeat(32);
const userOwnedVault = deriveVaultForWallet({ walletId: '0xuser-one', ownerLockHash });
assert.ok(userOwnedVault);
assert.equal(userOwnedVault.ownerLockHash, ownerLockHash);
assert.equal(userOwnedVault.ownerLockHashSource, 'user-lock-hash');
