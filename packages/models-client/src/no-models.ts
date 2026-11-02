import type { MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type {
  Embeddings,
  ExtractedFacts,
  Models,
  ModelServiceStatus,
  NliResults,
  RecognizedEntities,
  RerankScores,
  Summary,
} from './ports.js';

const unavailable = <T>(): Promise<Result<T, MindlogError>> =>
  Promise.resolve(
    err(mindlogError('UNAVAILABLE', 'no model service is configured (models.endpoint)')),
  );

const NONE = { modelId: '', ready: false };

/** No model service configured: memory runs in degraded mode (PLAN 21). */
export class NoModels implements Models {
  /** Never available, so pipelines skip model stages without calling. */
  available(): boolean {
    return false;
  }

  embed: Models['embed'] = () => unavailable<Embeddings>();
  recognize: Models['recognize'] = () => unavailable<RecognizedEntities>();
  classify: Models['classify'] = () => unavailable<NliResults>();
  rerank: Models['rerank'] = () => unavailable<RerankScores>();
  extractFacts: Models['extractFacts'] = () => unavailable<ExtractedFacts>();
  summarize: Models['summarize'] = () => unavailable<Summary>();

  health(): Promise<Result<ModelServiceStatus, MindlogError>> {
    return Promise.resolve(
      ok({
        ready: false,
        capabilities: {
          embed: NONE,
          ner: NONE,
          nli: NONE,
          rerank: NONE,
          extract: NONE,
          summarize: NONE,
        },
      }),
    );
  }
}
