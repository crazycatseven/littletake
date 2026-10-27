import { createReferenceHandler } from '../server/reference-api.ts';

export const maxDuration = 180;
export default { fetch: createReferenceHandler() };
