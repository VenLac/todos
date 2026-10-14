// "只填一部分的时间"的补齐规则（public/js/when.js，浏览器脚本，用 vm 加载）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const ctx = {};
runInNewContext(readFileSync(new URL('../public/js/when.js', import.meta.url), 'utf8'), ctx);
const { When } = ctx;
const P = (o = {}) => ({ y: '', mo: '', d: '', h: '', mi: '', ...o });
const BASE = '2026-10-14';

test('截止：空着的部分按这一天补齐', () => {
  assert.equal(When.due(P(), BASE).value, '');
  assert.equal(When.due(P({ h: '18' }), BASE).value, '2026-10-14T18:00');
  assert.equal(When.due(P({ h: '9', mi: '5' }), BASE).value, '2026-10-14T09:05');
  assert.equal(When.due(P({ d: '15' }), BASE).value, '2026-10-15');
  assert.equal(When.due(P({ d: '15', h: '18', mi: '30' }), BASE).value, '2026-10-15T18:30');
  assert.equal(When.due(P({ mo: '11', d: '1' }), BASE).value, '2026-11-01');
  assert.equal(When.due(P({ y: '27', mo: '1', d: '3' }), BASE).value, '2027-01-03');
  assert.equal(When.due(P({ y: '2027' }), BASE).value, '2027-10-14');
});

test('截止：不存在的日子和不合法的时刻会报错', () => {
  assert.match(When.due(P({ mo: '2', d: '30' }), BASE).error, /没有 30 日/);
  assert.match(When.due(P({ d: '31' }), '2026-11-05').error, /11 月没有 31 日/);
  assert.match(When.due(P({ mo: '13' }), BASE).error, /月份/);
  assert.match(When.due(P({ mi: '30' }), BASE).error, /先填小时/);
  assert.match(When.due(P({ h: '24' }), BASE).error, /小时/);
  assert.match(When.due(P({ h: '10', mi: '60' }), BASE).error, /分钟/);
});

test('开始 / 结束', () => {
  assert.deepEqual({ ...When.span('', '', '', '') }, { start: '', end: '' });
  assert.deepEqual({ ...When.span('9', '', '', '') }, { start: '09:00', end: '' });
  assert.deepEqual({ ...When.span('9', '30', '10', '') }, { start: '09:30', end: '10:00' });
  assert.deepEqual({ ...When.span('22', '', '24', '') }, { start: '22:00', end: '24:00' });
  assert.match(When.span('', '', '10', '').error, /先填开始/);
  assert.match(When.span('10', '', '9', '').error, /晚于开始/);
  assert.match(When.span('24', '', '', '').error, /小时/);
});

test('编辑时拆回格子：和这一天同一天的，年月日留空', () => {
  assert.deepEqual({ ...When.splitDue('2026-10-14T18:00', BASE) }, P({ h: '18', mi: '00' }));
  assert.deepEqual({ ...When.splitDue('2026-10-15', BASE) }, P({ y: '2026', mo: '10', d: '15' }));
  assert.deepEqual({ ...When.splitDue('', BASE) }, P());
});
