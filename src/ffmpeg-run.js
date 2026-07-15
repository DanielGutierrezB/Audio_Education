'use strict';

// Shared child-process helper for every FFmpeg invocation in the app
// (rendering, fusion, and analysis passes) — one place to get timeout
// handling, progress parsing, and cancellation right.

const { spawn } = require('child_process');
const binPaths = require('./bin-paths');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function runFfmpeg(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const spawnOpts = opts.cwd ? { cwd: opts.cwd } : undefined;
    const proc = spawn(binPaths.ffmpeg(), args, spawnOpts);
    if (opts.setCurrent) opts.setCurrent(proc);
    const timeoutMs = opts.timeout ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      if (opts.setCurrent) opts.setCurrent(null);
      reject(new Error(`ffmpeg timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    let stderr = '';
    proc.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;
      if (opts.onProgress && opts.duration) {
        const m = text.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d+)/);
        if (m) {
          const secs = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / Math.pow(10, m[4].length);
          opts.onProgress(Math.min(secs / opts.duration, 0.99));
        }
      }
    });
    proc.on('close', code => {
      clearTimeout(timer);
      if (opts.setCurrent) opts.setCurrent(null);
      if (code === 0 || code === null) resolve(stderr);
      else reject(new Error(`ffmpeg exited ${code}${stderr ? ': ' + stderr.slice(-300).trim() : ''}`));
    });
    proc.on('error', err => {
      clearTimeout(timer);
      if (opts.setCurrent) opts.setCurrent(null);
      reject(err);
    });
  });
}

function runFfprobe(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(binPaths.ffprobe(), args);
    let out = '';
    proc.stdout.on('data', c => { out += c; });
    proc.on('close', code => (code === 0 ? resolve(out) : reject(new Error('ffprobe failed'))));
    proc.on('error', reject);
  });
}

module.exports = { runFfmpeg, runFfprobe, DEFAULT_TIMEOUT_MS };
