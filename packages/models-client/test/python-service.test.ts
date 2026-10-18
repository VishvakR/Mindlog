import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterAll, describe } from 'vitest';
import { GrpcModels } from '@mindlog/models-client';
import { describeModelsContract } from './models-contract.js';

// The real Python service and models (TS ↔ Python contract, PLAN 22.1); skipped until
// `download_models.py` has filled python/model_service/models/.
const PYTHON = fileURLToPath(new URL('../../../python', import.meta.url));
const MODELS = `${PYTHON}/model_service/models/all-MiniLM-L6-v2/model.onnx`;

let child: ChildProcess | undefined;
let address: Promise<string> | undefined;

function start(): Promise<string> {
  address ??= new Promise((resolve, reject) => {
    child = spawn('uv', ['run', '--frozen', 'python', '-m', 'model_service'], {
      cwd: PYTHON,
      env: { ...process.env, MODEL_SERVICE_PORT: '0', HF_HUB_OFFLINE: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.on('error', reject);
    const lines = createInterface({ input: child.stdout ?? process.stdin });
    lines.on('line', (line) => {
      const m = /listening on (\S+)$/.exec(line);
      if (m?.[1]) resolve(m[1]);
    });
  });
  return address;
}

afterAll(() => {
  child?.kill('SIGTERM');
});

describe.skipIf(!existsSync(MODELS))(
  'the Python model service',
  () => {
    describeModelsContract(
      'GrpcModels → python',
      async () => new GrpcModels({ address: await start(), timeoutMs: 30_000 }),
    );
  },
  60_000,
);
