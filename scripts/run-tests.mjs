import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

// Run only current source tests (never stale compiler output) against compiled JS.
// This exercises the production worker path without per-worker tsx loader startup.
const files = (await readdir('tests')).filter(file => file.endsWith('.test.ts')).sort();
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=30000',
  ...files.map(file => '.local/test-build/tests/' + file.replace(/\.ts$/, '.js'))], { stdio: 'inherit' });
child.on('error', () => { console.error('Test runner could not start.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
