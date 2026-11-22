// 一键安装里「whisper 后端选择」的纯逻辑单测（不发网络、不碰文件）。
import assert from 'node:assert/strict';
import { suggestWhisperBackend, whisperVariants } from '../lib/installer.js';

// 1) Windows x64 有三个后端：CPU / CUDA 12.4 / CUDA 11.8
const x64 = whisperVariants('win32', 'x64').map((item) => item.id);
assert.deepEqual(x64, ['cpu', 'cuda-12.4', 'cuda-11.8']);
assert.ok(whisperVariants('win32', 'x64').every((item) => item.asset.endsWith('.zip')));

// 2) Windows arm64 有 CPU / CUDA 13.5 / OpenCL
assert.deepEqual(whisperVariants('win32', 'arm64').map((item) => item.id), ['cpu', 'cuda-13.5', 'opencl']);

// 3) macOS/Linux 没有 Windows 预编译包
assert.deepEqual(whisperVariants('darwin', 'arm64'), []);
assert.deepEqual(whisperVariants('linux', 'x64'), []);

// 4) 显卡推荐：NVIDIA → CUDA；其它/空 → CPU
assert.equal(suggestWhisperBackend(['NVIDIA GeForce RTX 4070'], 'x64'), 'cuda-12.4');
assert.equal(suggestWhisperBackend(['NVIDIA GeForce RTX 4070'], 'arm64'), 'cuda-13.5');
assert.equal(suggestWhisperBackend(['AMD Radeon RX 7800 XT']), 'cpu');
assert.equal(suggestWhisperBackend(['Intel(R) UHD Graphics 770']), 'cpu');
assert.equal(suggestWhisperBackend([]), 'cpu');
assert.equal(suggestWhisperBackend(['Microsoft Basic Display Adapter']), 'cpu');

console.log('installer.test.mjs: pass 12/12');
