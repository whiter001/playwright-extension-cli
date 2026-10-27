/**
 * Offline test for the extension token auto-discovery.
 *
 * `readExtensionToken()` digs the auth token out of the Chrome profile's
 * localStorage LevelDB. The bytes on disk are not a plain text dump: Chrome
 * stores the origin id in fragments with binary bytes in between, and the
 * token sits in the record that *follows* the id — other extensions store
 * their own tokens in the same neighbourhood.
 *
 * This test builds a synthetic LevelDB with that exact layout, so the parser
 * is covered without needing a browser or a real profile.
 *
 * Usage: node scripts/token-test.mjs
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { readExtensionToken } = require('../dist/relay/chrome.js');

/** The Playwright MCP extension id, as Chrome stores it. */
const EXTENSION_ID = 'mmlmfjhmonkocbjadbfplnigmagldckm';

/**
 * The readable fragments of the origin id. Chrome keeps these three as plain
 * text and encodes the rest, so the id shows up with binary gaps in between.
 */
const ID_FRAGMENTS = ['mmlmfjh', 'ocbjadbfpln', 'gldckm'];
const ID_GAPS = [[0x21, 0x0e, 0x28], [0xc1, 0xb5, 0x1c]];

/** A different extension that stores an auth token of its own. */
const OTHER_FRAGMENTS = ['jakfalnb', 'hgkpmoaak', 'pkailf'];

function fragments(list) {
  return Buffer.concat(list.map(part => Buffer.from(part, 'latin1')));
}

/** The origin id as Chrome writes it: fragments separated by binary bytes. */
function originIdBytes() {
  const parts = [];
  ID_FRAGMENTS.forEach((fragment, index) => {
    parts.push(Buffer.from(fragment, 'latin1'));
    if (index < ID_GAPS.length)
      parts.push(Buffer.from(ID_GAPS[index]));
  });
  return Buffer.concat(parts);
}

/** A 43 character base64url token, as the extension stores it. */
function fakeToken(seed) {
  return seed.repeat(Math.ceil(43 / seed.length)).slice(0, 43);
}

/**
 * A localStorage record: binary header, origin id, value header, value.
 * The filler bytes are outside the base64url alphabet, so they never extend
 * a token by accident.
 */
function record({ token, gapAfterId = 12, tail = 24, idBytes = originIdBytes() }) {
  return Buffer.concat([
    Buffer.from([0x9b, 0x01, 0x09, 0x2b, 0x1c, 0x09]),
    idBytes,
    Buffer.alloc(gapAfterId, 0x2a),
    Buffer.from(token, 'latin1'),
    Buffer.alloc(tail, 0x2b),
  ]);
}

/** The same, for an unrelated extension. */
function otherRecord({ token }) {
  return Buffer.concat([
    Buffer.from([0x4a, 0x1c, 0x09]),
    fragments(OTHER_FRAGMENTS),
    Buffer.from('auth-token', 'latin1'),
    Buffer.alloc(10, 0x2a),
    Buffer.from(token, 'latin1'),
    Buffer.alloc(20, 0x2b),
  ]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pwcli-token-'));
let profileCount = 0;

/** A throwaway profile directory with an empty LevelDB. */
function profile() {
  const dir = path.join(tmp, `profile-${++profileCount}`);
  const leveldb = path.join(dir, 'Local Storage', 'leveldb');
  fs.mkdirSync(leveldb, { recursive: true });
  return { dir, leveldb };
}

// ─── the layout Chrome really writes ──────────────────────────────────

{
  const p = profile();
  const token = fakeToken('alpha');
  fs.writeFileSync(path.join(p.leveldb, '000010.ldb'), record({ token }));
  assert.equal(await readExtensionToken(p.dir), token);
}
console.log('✓ the fragmented origin id is recognised and its token found');

// A contiguous id is tolerated as well.
{
  const p = profile();
  const token = fakeToken('bravo');
  fs.writeFileSync(path.join(p.leveldb, '000010.ldb'), record({
    token,
    idBytes: Buffer.from(EXTENSION_ID, 'latin1'),
  }));
  assert.equal(await readExtensionToken(p.dir), token);
}
console.log('✓ a contiguous origin id works too');

// ─── the token belongs to the record that follows the id ──────────────

{
  const p = profile();
  const ours = fakeToken('ours');
  const neighbour = fakeToken('other');
  const before = otherRecord({ token: fakeToken('before') });
  const mine = record({ token: ours });
  const after = otherRecord({ token: neighbour });
  const file = Buffer.concat([before, mine, after]);

  // The neighbour's token has to be close enough that "the last token in the
  // window" would have picked the wrong one — otherwise the test proves
  // nothing.
  const idEnd = before.length + 6 + originIdBytes().length;
  const neighbourOffset = idEnd + 12 + ours.length + 24 + 3 + fragments(OTHER_FRAGMENTS).length + 10;
  assert.ok(neighbourOffset - idEnd < 256, 'the neighbour must be close enough to be a plausible mistake');

  fs.writeFileSync(path.join(p.leveldb, '000010.ldb'), file);
  assert.equal(await readExtensionToken(p.dir), ours);
}
console.log('✓ a neighbouring extension’s token is not mistaken for ours');

// A token far away from the id is not attributed to it.
{
  const p = profile();
  fs.writeFileSync(path.join(p.leveldb, '000010.ldb'), record({
    token: fakeToken('distant'),
    gapAfterId: 300,
  }));
  assert.equal(await readExtensionToken(p.dir), undefined);
}
console.log('✓ a token too far from the id is ignored');

// A value that is not a 43 character token is not a token.
{
  const p = profile();
  fs.writeFileSync(path.join(p.leveldb, '000010.ldb'), record({ token: 'tooshort' }));
  assert.equal(await readExtensionToken(p.dir), undefined);
}
console.log('✓ a malformed token is ignored');

// ─── which file wins ──────────────────────────────────────────────────

{
  const p = profile();
  const older = fakeToken('older');
  const newer = fakeToken('newer');
  fs.writeFileSync(path.join(p.leveldb, '000012.ldb'), record({ token: older }));
  fs.writeFileSync(path.join(p.leveldb, '000013.log'), record({ token: newer }));
  assert.equal(await readExtensionToken(p.dir), newer);
}
console.log('✓ the newest file (the WAL) wins');

// ─── nothing to find ──────────────────────────────────────────────────

{
  const p = profile();
  fs.writeFileSync(path.join(p.leveldb, '000010.ldb'), otherRecord({ token: fakeToken('someone') }));
  assert.equal(await readExtensionToken(p.dir), undefined);
}
console.log('✓ a profile without the extension yields nothing');

{
  const p = profile();
  assert.equal(await readExtensionToken(p.dir), undefined);
  assert.equal(await readExtensionToken(path.join(tmp, 'does-not-exist')), undefined);
}
console.log('✓ a missing LevelDB directory is not an error');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nAll token discovery tests passed.');
