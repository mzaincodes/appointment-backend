/**
 * Local PostgreSQL server.
 *
 *   npm run db:start     start it (initialising on first run)
 *   npm run db:stop      stop it
 *   npm run db:status    is it running?
 *
 * Runs a real PostgreSQL from the binaries bundled by `embedded-postgres`, so
 * the project can be brought up on a machine with no system PostgreSQL, no
 * Homebrew and no Docker. The data lives in `backend/.pgdata` (gitignored) —
 * durable across reboots, unlike a temp directory.
 *
 * If PostgreSQL *is* installed system-wide, this script is unnecessary: point
 * DATABASE_URL at that server and run `npm run db:setup` instead.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  BOLD,
  DATA_DIR,
  DIM,
  RESET,
  fail,
  findBundledBinaries,
  isInitialised,
  isReachable,
  log,
  ok,
  resolveTarget,
  warn,
} from './db-lib';

const LOG_FILE = path.join(DATA_DIR, 'server.log');

function binaries(): string {
  const bin = findBundledBinaries();
  if (!bin) {
    fail('The bundled PostgreSQL binaries are not installed.');
    log(`\n  Run ${BOLD}npm install${RESET} in backend/, or install PostgreSQL yourself and`);
    log('  point DATABASE_URL at it, then run: npm run db:setup\n');
    process.exit(1);
  }
  return bin;
}

function run(command: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  };
}

function initialise(bin: string, target: ReturnType<typeof resolveTarget>): void {
  log(`  ${DIM}Initialising a new cluster in backend/.pgdata …${RESET}`);

  // initdb reads the superuser password from a file rather than an argument,
  // which keeps it out of the process list.
  const passwordFile = path.join(path.dirname(DATA_DIR), '.pgpass.tmp');
  fs.writeFileSync(passwordFile, target.password, { mode: 0o600 });

  try {
    const result = run(path.join(bin, 'initdb'), [
      '-D', DATA_DIR,
      '-U', target.user,
      `--pwfile=${passwordFile}`,
      '-E', 'UTF8',
      '--locale=C',
    ]);
    if (!result.ok) {
      fail('initdb failed');
      log(result.output);
      process.exit(1);
    }
  } finally {
    fs.rmSync(passwordFile, { force: true });
  }

  ok('Cluster initialised');
}

async function start(): Promise<void> {
  const target = resolveTarget();
  const bin = binaries();

  log(`\n${BOLD}Starting local PostgreSQL${RESET}`);
  log(`  ${DIM}port ${target.port} · database ${target.database} · user ${target.user}${RESET}\n`);

  if (await isReachable(target)) {
    ok(`Something is already listening on ${target.host}:${target.port}`);
    log(`\n  Next:  ${BOLD}npm run db:setup${RESET}\n`);
    return;
  }

  if (!isInitialised()) initialise(bin, target);

  // The Unix socket is placed inside the data directory. PostgreSQL caps socket
  // paths at ~103 bytes, and a deeply nested project directory can exceed that
  // — but the server still works over TCP, which is all the app uses.
  const result = run(path.join(bin, 'pg_ctl'), [
    '-D', DATA_DIR,
    '-l', LOG_FILE,
    '-o', `-p ${target.port} -k ${DATA_DIR}`,
    '-w',
    'start',
  ]);

  if (!result.ok) {
    fail('PostgreSQL failed to start');
    log(result.output);
    if (fs.existsSync(LOG_FILE)) {
      log(`\n${DIM}${fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-15).join('\n')}${RESET}`);
    }
    process.exit(1);
  }

  ok(`PostgreSQL is running on port ${target.port}`);
  log(`  ${DIM}data: backend/.pgdata   log: backend/.pgdata/server.log${RESET}`);
  log(`\n  Next:  ${BOLD}npm run db:setup${RESET}\n`);
}

function stop(): void {
  const bin = binaries();

  if (!isInitialised()) {
    warn('No local cluster exists — nothing to stop.');
    return;
  }

  const result = run(path.join(bin, 'pg_ctl'), ['-D', DATA_DIR, '-m', 'fast', 'stop']);
  if (result.ok) {
    ok('PostgreSQL stopped');
  } else if (/not running|No such/i.test(result.output)) {
    warn('PostgreSQL was not running.');
  } else {
    fail('Could not stop PostgreSQL');
    log(result.output);
    process.exit(1);
  }
}

async function status(): Promise<void> {
  const target = resolveTarget();
  const reachable = await isReachable(target);

  log(`\n${BOLD}Local PostgreSQL${RESET}`);
  log(`  data directory : ${isInitialised() ? 'initialised' : 'not created yet'}`);
  log(`  ${target.host}:${target.port}  : ${reachable ? `${'accepting connections'}` : 'not reachable'}`);
  log(`  database       : ${target.database}\n`);

  if (!reachable) log(`  Start it with:  ${BOLD}npm run db:start${RESET}\n`);
}

const command = process.argv[2] ?? 'start';

(async () => {
  switch (command) {
    case 'start':
      await start();
      break;
    case 'stop':
      stop();
      break;
    case 'status':
      await status();
      break;
    default:
      fail(`Unknown command "${command}". Use start, stop or status.`);
      process.exit(1);
  }
})().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
