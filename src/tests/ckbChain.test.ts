import assert from 'node:assert/strict';

const { normalizeCkbTxHash } = await import('../services/ckbChain.service.js');

assert.equal(
  normalizeCkbTxHash('  0x' + 'AB'.repeat(32) + '  '),
  '0x' + 'ab'.repeat(32)
);
assert.throws(() => normalizeCkbTxHash('0x1234'), /valid CKB testnet transaction hash/);
assert.throws(() => normalizeCkbTxHash('not-a-tx'), /valid CKB testnet transaction hash/);
