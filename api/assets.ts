import { createAssetsHandler } from '../server/assets/api.ts';
export const maxDuration = 180;
export default { fetch: createAssetsHandler() };
