import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationSource = join(repositoryRoot, 'db', 'migrations');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const createFixture = (includeDuplicate: boolean): string => {
  const root = mkdtempSync(join(tmpdir(), 'degen-migration-lifecycle-'));
  mkdirSync(join(root, 'tests'), { recursive: true });
  mkdirSync(join(root, 'db', 'migrations'), { recursive: true });
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });

  const packageJson = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  packageJson.scripts['db:apply'] = 'node fake-remote-write.mjs db:apply';
  packageJson.scripts['db:migrate'] = 'node fake-remote-write.mjs db:migrate';
  packageJson.scripts['deploy:worker'] = 'node fake-remote-write.mjs deploy:worker';
  writeFileSync(join(root, 'package.json'), JSON.stringify(packageJson, null, 2));

  copyFileSync(
    join(repositoryRoot, 'tests', 'd1-migration-order.test.ts'),
    join(root, 'tests', 'd1-migration-order.test.ts'),
  );
  copyFileSync(
    join(repositoryRoot, '.github', 'workflows', 'deploy-worker.yml'),
    join(root, '.github', 'workflows', 'deploy-worker.yml'),
  );
  for (const filename of readdirSync(migrationSource).filter((name) => name.endsWith('.sql'))) {
    copyFileSync(join(migrationSource, filename), join(root, 'db', 'migrations', filename));
  }
  if (includeDuplicate) {
    writeFileSync(
      join(root, 'db', 'migrations', '0007_player_sessions.sql'),
      '-- duplicate version fixture; never applied to a database\n',
    );
  }

  writeFileSync(
    join(root, 'fake-remote-write.mjs'),
    "import { writeFileSync } from 'node:fs';\nwriteFileSync('remote-write-ran', process.argv.slice(2).join(' '));\n",
  );
  return root;
};

const runNpmWriteCommand = (root: string, command: string) => spawnSync(
  npmCommand,
  ['run', command],
  { cwd: root, encoding: 'utf8', timeout: 30_000, env: process.env },
);

test('manual D1 and Worker npm writes run only after the migration preflight succeeds', () => {
  const validRoot = createFixture(false);
  const duplicateRoot = createFixture(true);
  try {
    for (const command of ['db:apply', 'db:migrate', 'deploy:worker']) {
      const valid = runNpmWriteCommand(validRoot, command);
      assert.equal(valid.error, undefined, valid.error?.message);
      assert.equal(valid.status, 0, `valid migration set should allow ${command}: ${valid.stdout}\n${valid.stderr}`);
      assert.equal(readFileSync(join(validRoot, 'remote-write-ran'), 'utf8'), command);
      rmSync(join(validRoot, 'remote-write-ran'), { force: true });

      const blocked = runNpmWriteCommand(duplicateRoot, command);
      assert.equal(blocked.error, undefined, blocked.error?.message);
      assert.notEqual(blocked.status, 0, `duplicate migration versions must block ${command}`);
      assert.equal(
        existsSync(join(duplicateRoot, 'remote-write-ran')),
        false,
        `${command} body must not run when the migration guard fails: ${blocked.stdout}\n${blocked.stderr}`,
      );
      assert.match(
        `${blocked.stdout}\n${blocked.stderr}`,
        /D1 migration version 0007 is duplicated/,
      );
    }
  } finally {
    rmSync(validRoot, { recursive: true, force: true });
    rmSync(duplicateRoot, { recursive: true, force: true });
  }
});
