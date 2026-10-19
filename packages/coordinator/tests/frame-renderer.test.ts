import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalFrameRenderer, clip, displayWidth } from '../src/terminal/frame-renderer.js';

const home = (row: number) => `\x1b[${row};1H`;

test('a frame is written whole, row by row in place, clearing screen and scrollback only before the first frame', () => {
  const frame = new TerminalFrameRenderer();
  const first = frame.render(['任务', 'running'], 30, 3);
  assert.equal(first, `\x1b[?25l\x1b[H\x1b[2J\x1b[3J${home(1)}任务\x1b[K${home(2)}running\x1b[K${home(3)}\x1b[K`);
  assert.equal(first.split('\x1b[2J').length, 2, 'the screen is cleared exactly once');
  assert.doesNotMatch(first, /\n/);
  const later = [frame.render(['任务', 'completed'], 30, 3), frame.render(['任务', 'completed', 'x'], 20, 2), frame.render(['again'], 30, 3)];
  for (const output of later) { assert.ok(output); assert.doesNotMatch(output, /\x1b\[2J|\x1b\[3J|\n/); }
  frame.close();
  assert.doesNotMatch(frame.render(['after close'], 30, 3), /\x1b\[2J|\x1b\[3J/, 'a re-hidden cursor never clears again');
});
test('an unchanged frame costs nothing and a changed one is repainted whole in place', () => {
  const frame = new TerminalFrameRenderer();
  frame.render(['任务', 'running'], 30, 3);
  assert.equal(frame.render(['任务', 'running'], 30, 3), '');
  assert.equal(frame.render(['任务', 'completed'], 30, 3), `${home(1)}任务\x1b[K${home(2)}completed\x1b[K${home(3)}\x1b[K`);
});
test('output never exceeds the pane height and rows removed from a shorter frame are blanked', () => {
  const frame = new TerminalFrameRenderer();
  frame.render(['keep', 'old', 'last', 'overflow'], 30, 3);
  const output = frame.render(['keep', 'new'], 30, 3);
  assert.equal(output, `${home(1)}keep\x1b[K${home(2)}new\x1b[K${home(3)}\x1b[K`);
  assert.doesNotMatch(output, /overflow|\x1b\[4;1H/);
});
test('resize repaints once and clips by display width so wide text cannot wrap', () => {
  const frame = new TerminalFrameRenderer();
  frame.render(['中文测试ABC', 'second', 'third'], 30, 4);
  const output = frame.render(['中文测试ABC', 'second', 'third'], 6, 2);
  assert.match(output, /\x1b\[1;1H中文…\x1b\[K/);
  assert.doesNotMatch(output, /third|\x1b\[3;1H|\n/);
  assert.equal(frame.render(['中文测试ABC', 'second', 'third'], 6, 2), '');
  assert.equal(displayWidth('中文a'), 5);
  assert.equal(clip('abcdef', 4), 'ab…');
});
test('cursor is hidden once while painting and restored once on exit', () => {
  const frame = new TerminalFrameRenderer(); assert.equal(frame.close(), '');
  assert.match(frame.render(['hello'], 30, 2), /^\x1b\[\?25l/);
  assert.doesNotMatch(frame.render(['hello again'], 30, 2), /\x1b\[\?25l/);
  assert.equal(frame.close(), '\x1b[?25h'); assert.equal(frame.close(), '');
});
