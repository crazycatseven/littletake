import { createSceneEditHandler } from '../server/scene-edit-api.ts';

export const maxDuration = 180;
export default { fetch: createSceneEditHandler() };
