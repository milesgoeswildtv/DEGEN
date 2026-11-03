import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const workerEntry = read('../worker/index.ts');
const deployWorkflow = read('../.github/workflows/deploy-worker.yml');

test('Worker deployment watches every shared source module imported by the Worker entrypoint', () => {
  const sharedImports = Array.from(
    workerEntry.matchAll(/from ['"]\.\.\/(src\/[^'"]+)['"]/g),
    (match) => match[1],
  );
  assert.ok(sharedImports.length > 0, 'Worker entrypoint must expose shared source imports');

  for (const sourcePath of sharedImports) {
    const trackedPath = sourcePath.endsWith('.ts') ? sourcePath : `${sourcePath}.ts`;
    assert.ok(
      deployWorkflow.includes(`      - '${trackedPath}'`),
      `Worker deployment must run when ${trackedPath} changes`,
    );
  }

  assert.ok(deployWorkflow.includes("      - 'worker/**'"),
    'Worker-local runtime modules must remain covered by the deploy path filter');
});
