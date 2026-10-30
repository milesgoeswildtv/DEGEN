import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationSource = join(repositoryRoot, 'db', 'migrations');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

interface Fixture {
  root: string;
  marker: string;
  env: NodeJS.ProcessEnv;
}

const createFixture = (includeDuplicate: boolean): Fixture => {
  const root = mkdtempSync(join(tmpdir(), 'degen-migration-command-guard-'));
  const tests = join(root, 'tests');
  const migrations = join(root, 'db', 'migrations');
  const workflow = join(root, '.github', 'workflows');
  const fakeBin = join(root, 'fake-bin');
  mkdirSync(tests, { recursive: true });
  mkdirSync(migrations, { recursive: true });
  mkdirSync(workflow, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });

  copyFileSync(join(repositoryRoot, 'package.json'), join(root, 'package.json'));
  copyFileSync(
    join(repositoryRoot, 'tests', 'd1-migration-order.test.ts'),
    join(tests, 'd1-migration-order.test.ts'),
  );
  copyFileSync(
    join(repositoryRoot, '.github', 'workflows', 'deploy-worker.yml'),
    join(workflow, 'deploy-worker.yml'),
  );
  for (const filename of readdirSync(migrationSource).filter((name) => name.endsWith('.sql'))) {
    copyFileSync(join(migrationSource, filename), join(migrations, filename));
  }
  if (includeDuplicate) {
    writeFileSync(
      join(migrations, '0007_player_sessions.sql'),
      '-- duplicate version fixture; never applied to a database\n',
    );
  }

  const fakeWranglerScript = join(root, 'fake-wrangler.mjs');
  writeFileSync(
    fakeWranglerScript,
    "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.DEGEN_REMOTE_WRITE_MARKER, process.argv.slice(2).join(' '));\n",
  );
  const wrapperPath = join(fakeBin, process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
  const wrapper = process.platform === 'win32'
    ? '@echo off\r\nnode "%DEGEN_FAKE_WRANGLER%" %*\r\n'
    : '#!/bin/sh\nexec node "$DEGEN_FAKE_WRANGLER" "$@"\n';
  writeFileSync(wrapperPath, wrapper);
  if (process.platform !== 'win32') chmodSync(wrapperPath, 0o755);

  const marker = join(root, 'remote-write-ran');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [fakeBin, process.env.PATH ?? ''].join(delimiter),
    DEGEN_FAKE_WRANGLER: fakeWranglerScript,
    DEGEN_REMOTE_WRITE_MARKER: marker,
    npm_config_ignore_scripts: 'false',
  };
  delete env.npm_lifecycle_event;
  delete env.npm_lifecycle_script;
  delete env.npm_package_json;
  delete env.npm_config_local_prefix;
  delete env.npm_command;
  // Node's test runner marks child processes so nested `node --test` calls skip.
  // Clear that marker so the migration preflight really executes in this fixture.
  delete env.NODE_TEST_CONTEXT;
  return { root, marker, env };
};

const runNpmWriteCommand = (fixture: Fixture, command: string) => spawnSync(
  npmCommand,
  ['--prefix', fixture.root, 'run', command],
  { cwd: fixture.root, encoding: 'utf8', timeout: 30_000, env: fixture.env },
);

test('manual D1 and Worker npm writes stop before Wrangler when migration versions collide', () => {
  const valid = createFixture(false);
  const duplicate = createFixture(true);
  try {
    const expectedWranglerArgs: Record<string, string> = {
      'db:apply': 'd1 execute DEGEN --remote --file=db/schema.sql',
      'db:migrate': 'd1 migrations apply DEGEN --remote',
      'deploy:worker': 'deploy',
    };
    for (const command of Object.keys(expectedWranglerArgs)) {
      const allowed = runNpmWriteCommand(valid, command);
      assert.equal(allowed.error, undefined, allowed.error?.message);
      assert.equal(
        allowed.status,
        0,
        `unique migration versions should allow ${command}: ${allowed.stdout}\n${allowed.stderr}`,
      );
      assert.equal(readFileSync(valid.marker, 'utf8'), expectedWranglerArgs[command]);
      rmSync(valid.marker, { force: true });

      const blocked = runNpmWriteCommand(duplicate, command);
      assert.equal(blocked.error, undefined, blocked.error?.message);
      assert.notEqual(
        blocked.status,
        0,
        `duplicate migration versions must block ${command}: ${blocked.stdout}\n${blocked.stderr}`,
      );
      assert.equal(
        existsSync(duplicate.marker),
        false,
        `${command} must not invoke Wrangler after a failed migration preflight`,
      );
      assert.match(
        `${blocked.stdout}\n${blocked.stderr}`,
        /D1 migration version 0007 is duplicated/,
      );
    }
  } finally {
    rmSync(valid.root, { recursive: true, force: true });
    rmSync(duplicate.root, { recursive: true, force: true });
  }
});
