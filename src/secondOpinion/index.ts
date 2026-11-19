import { config } from '../config.js';
import { createOcrProvider } from './ocr.js';
import {
  isSecondOpinionName, SECOND_OPINION_NAMES,
  type SecondOpinionChoice, type SecondOpinionName, type SecondOpinionProvider,
} from './types.js';

const PROVIDERS: Record<SecondOpinionName, SecondOpinionProvider> = {
  ocr: createOcrProvider(),
};

const overrides = new Map<SecondOpinionName, SecondOpinionProvider>();

/** Only for tests: answer `name` with `provider` (null restores the real one). */
export function setSecondOpinionProviderForTests(name: SecondOpinionName, provider: SecondOpinionProvider | null): void {
  if (provider) overrides.set(name, provider);
  else overrides.delete(name);
}

export function getSecondOpinionProvider(name: SecondOpinionName): SecondOpinionProvider {
  return overrides.get(name) ?? PROVIDERS[name];
}

export function secondOpinionNotInstalled(provider: SecondOpinionProvider): string {
  return `${provider.label} is not installed: ${provider.bin} not found on PATH`;
}

export interface SecondOpinionProviderSummary {
  name: SecondOpinionName;
  label: string;
  available: boolean;
  /** What to do when it is not available; null when it is. */
  hint: string | null;
}

/** Cheap: no CLI is started. */
export function listSecondOpinionProviders(): SecondOpinionProviderSummary[] {
  return SECOND_OPINION_NAMES.map((name) => {
    const provider = getSecondOpinionProvider(name);
    const available = provider.isAvailable();
    return { name, label: provider.label, available, hint: available ? null : secondOpinionNotInstalled(provider) };
  });
}

/** `SECOND_OPINION`: the choice a request that names none gets. */
export function defaultSecondOpinion(): SecondOpinionChoice {
  return config.SECOND_OPINION;
}

/**
 * The provider a new run uses, or null for none. A provider named by the
 * caller must be installed, or this throws (the caller answers 400). Without
 * one, a re-run keeps `inherited` and a new run takes the env default; an
 * uninstalled provider reached that way is skipped when the run gets to it.
 */
export function resolveSecondOpinion(
  requested: SecondOpinionChoice | undefined,
  inherited?: SecondOpinionName | null,
): SecondOpinionName | null {
  if (requested === 'none') return null;
  if (requested !== undefined) {
    const provider = getSecondOpinionProvider(requested);
    if (!provider.isAvailable()) throw new Error(secondOpinionNotInstalled(provider));
    return requested;
  }
  if (inherited !== undefined) return inherited;
  const fallback = defaultSecondOpinion();
  return isSecondOpinionName(fallback) ? fallback : null;
}

export { isSecondOpinionName, SECOND_OPINION_NAMES };
export type { SecondOpinionChoice, SecondOpinionName, SecondOpinionProvider };
