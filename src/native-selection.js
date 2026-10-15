import { stateError } from './atomic-state.js';

export function observedParentSelection(controller) {
  const observed = controller?.adapterState;
  const billing = controller?.billingObservation;
  if (observed?.selectionGate?.allowed !== true || !observed.actualModel || !observed.actualProvider || !billing?.billingMode) return null;
  return { modelId: observed.actualModel, providerId: observed.actualProvider, billingMode: billing.billingMode };
}

export function inheritNativeSelection(request, parent) {
  if (!parent) throw stateError('NATIVE_PARENT_SELECTION_REQUIRED', 'Native queueing requires the registered parent model/provider/billing observation');
  if (request === undefined || request === null || request === 'inherit') return { ...parent };
  if (typeof request !== 'object' || Array.isArray(request)) throw stateError('INVALID_NATIVE_SELECTION', 'Use selection:"inherit" or an object matching the observed parent');
  for (const key of Object.keys(request)) if (!['modelId', 'providerId', 'billingMode'].includes(key)) throw stateError('INVALID_NATIVE_SELECTION', `Unsupported native selection field ${key}; use selection:"inherit"`);
  for (const key of ['modelId', 'providerId', 'billingMode']) {
    const value = request[key];
    const placeholder = value === undefined || value === null || value === '' || key === 'billingMode' && value === 'unknown';
    if (placeholder) continue;
    if (typeof value !== 'string' || value !== parent[key]) throw stateError('NATIVE_SELECTION_CONFLICT', `${key} conflicts with the observed native parent; use another supported adapter rather than silently overriding it`);
  }
  return { ...parent };
}
