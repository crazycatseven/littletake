# Project script components

Muse can author a reusable JavaScript controller, check it, and propose attaching it to a scene object. The existing Muse conversation, review/apply, history and project save mechanisms own these changes.

## Authoring and mounting

Select an object, open **Add Component → Project Scripts…**, create or edit a script, and choose **Check & Save**. Attach its name from **Add Component**. Its declared number, boolean and choice parameters appear in Inspector alongside **Start Control**. A controller has one independent state and parameter set per object. Replace an existing input controller explicitly before mounting another.

For Muse, ask for the object's control behavior. `read_script` reads definitions and users. `check_script` compiles and runs a bounded input sequence, optionally against a real object's transform, parameters and joint limits. `use_checked_script` identifies the exact checked definition in the final proposal; `attach_script` binds it. Revision checks reject stale edits. The plan is applied only through the existing review flow.

## Source of truth

- [model.ts](model.ts) defines the manifest, public fields, instance reference and working starter controller.
- [contract.ts](contract.ts) is the API specification shared by Muse and the source editor. Scripts define `init(ctx)` and `update(ctx)` using explicit input, pose, joint, parameter and state values.
- [runtime.ts](runtime.ts) runs each controller in QuickJS WASM, with bounded execution and memory. It exposes no browser, network, filesystem or editor APIs.
- [check.ts](check.ts) binds synthetic input checks to actual project objects. Checks catch runtime failures; the scene remains the place to judge the feel of the controls.
- [operations.ts](operations.ts) owns definition revisions, mounting and parameter migration. [server/scripts/tools.ts](../../server/scripts/tools.ts) exposes these through the existing agent tool loop.
- [editor.ts](editor.ts) is the optional source editor; ordinary users can ask Muse and use the component fields.

Scripts live in `project.scripts[]`; source is `project.scripts[].source`. Components store `scriptId`, `enabled` and instance `parameters`. The project document is saved by the existing server workspace storage and included in `project.json` when exported. There is no arbitrary executable directory or browser-persistent script store. Shared global prefabs do not carry references to project-owned scripts; attach a controller after placement.

## Hot reload and performance

Saving checks the new revision before it can replace the active runtime. A swap preserves the current pose and compatible parameters. Keeping `stateVersion` preserves explicit state; changing it reinitializes state. A failed swap retains the previous runtime and reports the problem. Shared script edits affect all attached instances; use a new script ID for an independent variant.

Recording pins its script revision and parameters until review ends. **Keep Take** writes ordinary position, rotation, changed scale and bound-joint keys through the existing animation model. Replay and export evaluate those keys without running scripts. Control parameters such as movement speed are not keyframe channels.

Version 1 exposes one active input controller per object, a fixed keyboard/mouse input contract, self transforms and bound joints, and declarative Inspector fields. Custom DOM, arbitrary editor commands, cross-object mutation and additional script-defined buttons are outside this API.
