import type { Db } from '@/db';
import { getExtractionModel, getSecret, SETTING_KEYS } from '../settings';
import { OpenAiProvider } from './openai';
import type { DocumentIntelligenceProvider } from './types';

/**
 * Selects the configured provider.
 *
 * Adding a vendor means adding a file beside `openai.ts` and a branch here.
 * Nothing else in the application changes — which is the property this
 * indirection exists to guarantee, and the reason the rest of the codebase
 * imports `getProvider()` rather than any vendor's module.
 */
export async function getProvider(db: Db): Promise<DocumentIntelligenceProvider | null> {
  const apiKey = await getSecret(db, SETTING_KEYS.openaiApiKey);
  if (apiKey) {
    return new OpenAiProvider(apiKey, await getExtractionModel(db));
  }
  return null;
}

export * from './types';
