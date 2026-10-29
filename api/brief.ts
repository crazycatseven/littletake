import { createBriefHandler } from '../server/look-api.ts';

export const maxDuration = 180;
export default { fetch: createBriefHandler() };
