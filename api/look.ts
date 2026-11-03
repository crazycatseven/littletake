import { createLookHandler } from '../server/look-api.ts';

export const maxDuration = 180;
export default { fetch: createLookHandler() };
