import { CoordinatorError } from './errors.js';

export interface ModelCapability {
  model: string;
  efforts: string[];
}

export interface ModelChoice {
  model: string;
  effort: string;
}

export function assertSupportedModelChoice(choice: ModelChoice, catalog: ModelCapability[]): void {
  const model = catalog.find((entry) => entry.model === choice.model);
  if (!model || !model.efforts.includes(choice.effort)) {
    throw new CoordinatorError('MODEL_EFFORT_UNSUPPORTED', 'Requested model and thinking effort are not supported by the current catalog.', 'Refresh model/list and choose a listed model and effort.');
  }
}
