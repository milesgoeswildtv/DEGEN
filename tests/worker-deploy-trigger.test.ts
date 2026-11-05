import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workerEntryPath = resolve(repoRoot, 'worker/index.ts');
const deployWorkflow = readFileSync(resolve(repoRoot, '.github/workflows/deploy-worker.yml'), 'utf8');
const ciWorkflow = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8');
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

const runtimeImportSpecifiers = (source: string): string[] => {
  const specifiers = new Set<string>();
  const staticImports = /^\s*(?:import|export)\s+(?!type\b)(?:[\s\S]*?\s+from\s*)?['"]((?:\.{1,2})\/[^'"]+)['"]/gm;
  const dynamicImports = /\bimport\s*\(\s*['"]((?:\.{1,2})\/[^'"]+)['"]\s*\)/g;

  for (const match of source.matchAll(staticImports)) {
    if (match[1]) specifiers.add(match[1]);
  }
  for (const match of source.matchAll(dynamicImports)) {
    if (match[1]) specifiers.add(match[1]);
  }
  return [...specifiers];
};

const resolveLocalImport = (importerPath: string, specifier: string, root: string): string => {
  const target = resolve(dirname(importerPath), specifier);
  const extension = extname(target);
  const candidates = extension
    ? [
      target,
      ...(extension === '.js' || extension === '.mjs' || extension === '.cjs'
        ? [target.replace(/\.(?:m?js|cjs)$/, '.ts')]
        : []),
    ]
    : [
      target + '.ts',
      target + '.tsx',
      target + '.js',
      target + '.mjs',
      join(target, 'index.ts'),
      join(target, 'index.tsx'),
      join(target, 'index.js'),
    ];
  const resolvedPath = candidates.find(existsSync);
  assert.ok(
    resolvedPath,
    'Worker runtime import "' + specifier + '" from ' + relative(root, importerPath) + ' must resolve to a tracked local file',
  );
  return resolvedPath;
};

const collectWorkerRuntimeFiles = (entryPath = workerEntryPath, root = repoRoot): string[] => {
  const visited = new Set<string>();

  const visit = (filePath: string): void => {
    const absolutePath = resolve(filePath);
    if (visited.has(absolutePath)) return;
    visited.add(absolutePath);

    if (!sourceExtensions.has(extname(absolutePath))) return;

    const source = readFileSync(absolutePath, 'utf8');
    for (const specifier of runtimeImportSpecifiers(source)) {
      visit(resolveLocalImport(absolutePath, specifier, root));
    }
  };

  visit(entryPath);
  return [...visited]
    .map((filePath) => relative(root, filePath).split(sep).join('/'))
    .filter((filePath) => filePath.startsWith('src/'))
    .sort();
};

test('Worker import graph follows transitive runtime imports and excludes type-only imports', () => {
  const root = mkdtempSync(join(tmpdir(), 'degen-worker-import-graph-'));
  const workerDir = join(root, 'worker');
  const sharedDir = join(root, 'src', 'shared');
  const typesDir = join(root, 'src', 'types');

  try {
    mkdirSync(workerDir, { recursive: true });
    mkdirSync(sharedDir, { recursive: true });
    mkdirSync(typesDir, { recursive: true });
    writeFileSync(join(workerDir, 'index.ts'), "import { run } from './runtime';\n");
    writeFileSync(
      join(workerDir, 'runtime.ts'),
      "import { execute } from '../src/shared/entry';\n" +
        "import type { Contract } from '../src/types/contract';\n" +
        "const load = () => import('../src/shared/lazy');\n",
    );
    writeFileSync(join(sharedDir, 'entry.ts'), "export { execute } from './nested';\n");
    writeFileSync(join(sharedDir, 'nested.ts'), 'export const execute = () => undefined;\n');
    writeFileSync(join(sharedDir, 'lazy.ts'), 'export const lazy = true;\n');
    writeFileSync(join(typesDir, 'contract.ts'), 'export interface Contract {}\n');

    assert.deepEqual(
      collectWorkerRuntimeFiles(join(workerDir, 'index.ts'), root),
      ['src/shared/entry.ts', 'src/shared/lazy.ts', 'src/shared/nested.ts'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Worker deployment watches every shared runtime module in the transitive import graph', () => {
  const sharedRuntimeFiles = collectWorkerRuntimeFiles();
  assert.ok(sharedRuntimeFiles.length > 0, 'Worker entrypoint must import shared source modules');

  for (const sourcePath of sharedRuntimeFiles) {
    assert.ok(
      deployWorkflow.includes("      - '" + sourcePath + "'"),
      'Worker deployment must run when transitive runtime dependency ' + sourcePath + ' changes',
    );
  }

  assert.ok(
    deployWorkflow.includes("      - 'worker/**'"),
    'Worker-local runtime modules must remain covered by the deploy path filter',
  );
});


test('Worker deployment completes the full local QA gate before any remote D1 write', () => {
  const commands = (workflow: string): string[] =>
    [...workflow.matchAll(/^\s+run:\s*(.+?)\s*$/gm)].map((match) => match[1]!);
  const ciCommands = commands(ciWorkflow);
  const deployCommands = commands(deployWorkflow);
  const remoteCommands = ['npm run db:apply', 'npm run db:migrate', 'npm run deploy:worker'];

  assert.ok(ciWorkflow.includes('branches: [main, automation/degen/d1-migration-number-guard-v01]'),
    'CI must run for both main and the stacked migration-guard base branch');
  assert.ok(ciCommands.includes('npm run check:migrations'),
    'CI must exercise the same tracked migration preflight used by deployment');
  assert.ok(!ciCommands.some((command) => /(?:--remote|db:apply|db:migrate|deploy:worker)/.test(command)),
    'CI must not perform remote D1 or Worker writes');
  assert.deepEqual(
    deployCommands.slice(0, ciCommands.length),
    ciCommands,
    'Worker deployment must complete the exact CI command sequence before remote writes',
  );
  assert.deepEqual(
    deployCommands.slice(ciCommands.length),
    remoteCommands,
    'only schema → tracked migrations → Worker deployment may follow the QA gate',
  );
});

test('production Worker deployments serialize D1 migrations and never cancel an in-flight release', () => {
  assert.match(
    deployWorkflow,
    /^concurrency:\n  group: degen-worker-production\n  cancel-in-progress: false$/m,
    'production D1 migrations and Worker deployments must share one non-cancelling concurrency lane',
  );
});
