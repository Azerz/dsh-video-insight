/**
 * 存储清理策略的单元测试：只测 pruneDirectory 的保留规则（不碰真实 ~/.dsh）。
 * 运行：node test/storage.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pruneDirectory } from '../lib/storage.js';

let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}`);
  }
}

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

async function makeDir(files) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-storage-test-'));
  for (const [name, ageDays] of files) {
    const path = join(dir, name);
    await writeFile(path, name.repeat(10));
    const stamp = new Date(now - ageDays * DAY);
    await utimes(path, stamp, stamp);
  }
  return dir;
}

async function names(dir) {
  return (await readdir(dir)).sort();
}

// 1) 按天数过期：超过 keepDays 的删掉，最近保留
{
  const dir = await makeDir([['old.json', 120], ['fresh.json', 3]]);
  const result = await pruneDirectory(dir, { keepDays: 90, now });
  const left = await names(dir);
  check('按天数删除过期文件', result.removed === 1 && left.length === 1 && left[0] === 'fresh.json');
  check('返回释放字节数', result.freedBytes > 0);
  await rm(dir, { recursive: true, force: true });
}

// 2) keepDays = 0 表示不按时间删，只按数量
{
  const dir = await makeDir([['a.json', 400], ['b.json', 300]]);
  const result = await pruneDirectory(dir, { keepDays: 0, now });
  check('keepDays=0 不按时间清理', result.removed === 0 && (await names(dir)).length === 2);
  await rm(dir, { recursive: true, force: true });
}

// 3) 按文件数量保留最近 keepCount 个
{
  const dir = await makeDir([['one.json', 10], ['two.json', 5], ['three.json', 1]]);
  const result = await pruneDirectory(dir, { keepDays: 0, keepCount: 2, now });
  const left = await names(dir);
  check('按数量保留最近 N 个', result.removed === 1 && left.length === 2 && left.includes('three.json') && left.includes('two.json'));
  await rm(dir, { recursive: true, force: true });
}

// 4) 分镜按视频分组：同一 docId 的 json + 多张 jpg 一起保留或一起删
{
  const dir = await makeDir([
    ['youtube_old.json', 40],
    ['youtube_old-1.jpg', 40],
    ['youtube_old-2.jpg', 40],
    ['youtube_new.json', 2],
    ['youtube_new-1.jpg', 2],
    ['youtube_new-2.jpg', 2],
  ]);
  const result = await pruneDirectory(dir, { keepDays: 0, keepCount: 1, group: true, now });
  const left = await names(dir);
  check('分镜按视频分组保留最近 1 个视频', left.length === 3 && left.every((name) => name.startsWith('youtube_new')));
  check('分组清理数量正确', result.removed === 3);
  await rm(dir, { recursive: true, force: true });
}

// 5) 目录不存在时不报错
{
  const result = await pruneDirectory(join(tmpdir(), 'dsh-storage-missing-dir'), { keepDays: 90, now });
  check('目录不存在返回 0', result.removed === 0 && result.freedBytes === 0);
}

console.log(`\nstorage.test.mjs: pass ${passed}/${passed + failed}`);
if (failed > 0) process.exit(1);
