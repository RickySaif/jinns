// Run with: node --test _jinns/test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSnapshot, psToLines, lsofToLines, treeOf, treePorts, slug, cmdQuote } from './platform.mjs';

// What WIN_SNAPSHOT_PS prints on Windows: cmd.exe (Jinns' shell) -> npm -> node (vite), plus an esbuild helper.
const WINDOWS_OUTPUT = [
  'P 4 0', 'P 1200 4', 'P 5000 1200',
  'P 7000 5000', 'P 7100 7000', 'P 7200 7100', 'P 7300 7200',
  'P 9000 1200',
  'L 4 445', 'L 7200 4800', 'L 7200 24678', 'L 9000 4801', '',
].join('\r\n');

test('parses Windows process and port lines (CRLF)', () => {
  const snap = parseSnapshot(WINDOWS_OUTPUT);
  assert.equal(snap.parent.get(7200), 7100);
  assert.deepEqual([...snap.listen.get(7200)], [4800, 24678]);
  assert.deepEqual(treePorts(7000, snap), [4800, 24678]);
  assert.deepEqual(treePorts(9000, snap), [4801]);
});

test('ignores headers, blanks and junk', () => {
  const snap = parseSnapshot('ProcessId ParentProcessId\n\nP x y\nL 12 80\n');
  assert.equal(snap.parent.size, 0);
  assert.deepEqual([...snap.listen.get(12)], [80]);
});

test('reads macOS ps and lsof output', () => {
  const ps = '    1     0\n  500     1\n  501   500\n  502   501\n';
  const lsof = 'p502\nn*:4173\nn[::1]:5173\np900\nn127.0.0.1:4747\n';
  const snap = parseSnapshot(`${psToLines(ps)}\n${lsofToLines(lsof)}`);
  assert.deepEqual(treePorts(500, snap), [4173, 5173]);
  assert.deepEqual(treePorts(900, snap), [4747]);
});

test('process trees survive cycles and pid 0', () => {
  assert.deepEqual(treeOf(0, new Map([[0, 0], [1, 0], [2, 1]])), [0, 1, 2]);
  assert.deepEqual(treeOf(2, new Map([[2, 3], [3, 2], [4, 3]])).sort(), [2, 3, 4]);
});

test('folder names become domain names', () => {
  assert.equal(slug('Scrum-AI-Addendum'), 'scrum-ai-addendum');
  assert.equal(slug('my self inc'), 'my-self-inc');
  assert.equal(slug('Bitcoin Treasury Guild!'), 'bitcoin-treasury-guild');
  assert.equal(slug('___'), 'app');
});

test('cmd.exe quoting keeps spaces and parens inside one argument', () => {
  assert.equal(cmdQuote('C:\\Users\\Ana Lee\\x.json'), '"C:\\Users\\Ana Lee\\x.json"');
  assert.equal(cmdQuote('Bash(npm run:*)'), '"Bash(npm run:*)"');
  assert.equal(cmdQuote('say "hi"'), `"say 'hi'"`);
});
