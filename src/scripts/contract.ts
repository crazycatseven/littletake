/** Shared by Muse's tool harness and the script editor. */
export const SCRIPT_CONTRACT = `LittleTake Script Component API v1
Scripts are project assets: {id,name,revision,apiVersion:1,stateVersion,description,controls,fields,source}.
source is plain JavaScript defining function update(ctx) and optionally function init(ctx).
init returns a plain state object. update mutates ctx.pose, ctx.state, ctx.joints and returns nothing, or returns {pose,state,joints}.
ctx = {dt,time,input:{keys,mouse:{dx,dy,buttons}},pose:{position,rotation,scale},joints,params,state}.
dt and time are seconds. pose is WORLD space, Y up, +Z forward; XYZ Euler rotation uses degrees. Parent transforms are handled by the editor.
Initialize heading and other pose-dependent state from ctx.pose, never an assumed zero orientation. dt=0 must not advance motion. Start Control should stay at rest until input unless autonomous motion was explicitly requested.
input.keys is a BOOLEAN OBJECT, not an array or Set: {w:false,a:false,s:false,d:false,f:false,v:false,shift:false,space:false}. Read ctx.input.keys.w or ctx.input.keys['w']; never use includes/has. mouse dx/dy are viewport-normalized drag deltas, buttons is a bitmask.
Only the attached object's transform and existing bound joint IDs can be changed. Read exact joint IDs from the object/prefab. Output position must stay within +/-1000m, scale .01..100, joint limits must be respected.
State is a flat dictionary (max64 entries) of finite numbers, booleans, short strings or number arrays (max16). Every instance gets its own state. Use ctx.time or state; no Date/Math.random.
Fields (max32) use stable key,label,type. number also declares default,min,max,step; boolean declares default; choice declares default,options. Parameters are control settings, NOT keyframe channels.
All fields are automatically shown in Inspector. Start Control and recording are owned by the editor. Do not write DOM, event listeners, UI, network, imports, timers or async code. No host APIs are exposed.
Execution is isolated with 8MB memory, 256KB stack and 8ms/update budgets. Keep per-frame work small. A check is a bounded smoke test, not proof of every possible input.
The check simulates W for 15 steps and D for 15 steps. Inspect the returned pose/state to confirm the advertised inputs actually produce motion; repair unintended no-ops before proposing the controller.
Hot reload preserves pose and compatible parameters. Keep stateVersion when state keys retain meaning, increment it to initialize new state. Recording pins the active revision. Playback/export use baked property keys, never rerun controllers.
Editing a shared script affects all its users. For an object-specific change, create a new script ID and attach that copy. Read scripts first; preserve independent instance parameters.
Use check_script {script,target:{sceneId,id}} for every new/changed script. target selects the real object's pose, parameters and joints for the check; null uses an existing instance or an empty synthetic object. It returns a checkId for the EXACT checked source. Include use_checked_script {sceneId,checkId} before attach_script in the final plan. Never claim changes are applied before user review.
attach_script {sceneId,id,scriptId,parameters,replaceController} uses an object ID. parameters={} uses defaults. Explicit replacement removes the prior input controller, retaining passive components and animation.
Do not remove animation or Follow Path silently. Disable Follow Path explicitly in the editor before live control.
Default W/S forward/back, A/D turn. Match the editor's +Z-forward controls: pose.rotation[1] += (Number(input.keys.d) - Number(input.keys.a)) * turnSpeed * dt; positive yaw turns toward +X. Do not add Q/E strafing. Mouse pitch/yaw use viewport drag. For flight, do not clamp Y to the ground unless explicitly requested; underwater routes must remain possible.
Prefer useful editable proxy motion over full aerodynamics. Describe actual capabilities, binding requirements and controls in English metadata.`;
