import { mindlogError } from '@mindlog/core';
import type { Models } from '@mindlog/models-client';
import { FakeModels, serveModels } from '@mindlog/models-client';

type Mode = 'busy' | 'missing' | 'slow';

/** FakeModels where a capability can be made to answer busy, missing or slowly. */
function withModes(fake: FakeModels, modes: Partial<Record<'embed' | 'ner', Mode>>): Models {
  const gate = async <T>(mode: Mode | undefined, run: () => Promise<T>): Promise<T> => {
    if (mode === 'busy') return { ok: false, error: mindlogError('BUSY', 'queue full') } as T;
    if (mode === 'missing')
      return { ok: false, error: mindlogError('UNAVAILABLE', 'model not loaded') } as T;
    if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 500));
    return run();
  };
  return {
    embed: (texts, kind) => gate(modes.embed, () => fake.embed(texts, kind)),
    recognize: (texts, labels) => gate(modes.ner, () => fake.recognize(texts, labels)),
    classify: (pairs) => fake.classify(pairs),
    rerank: (q, docs) => fake.rerank(q, docs),
    extractFacts: (text) => fake.extractFacts(text),
    health: () => fake.health(),
  };
}

/** The model service's gRPC API answered by FakeModels, without Python or real models. */
export function startFakeModelServer(modes: Partial<Record<'embed' | 'ner', Mode>> = {}) {
  return serveModels(withModes(new FakeModels(), modes));
}
