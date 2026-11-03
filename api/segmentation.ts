import { createSegmentationHandler } from '../server/reference/sam/api.ts';

export const maxDuration = 180;
export default { fetch: createSegmentationHandler() };
