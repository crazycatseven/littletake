# WebXR editor

Open the app in a WebXR headset browser with tracked controllers and choose **Enter VR**. Desktop and VR share the project and undo history within the same browser; use project export/import between devices.

Tracked controllers appear alongside their pointing rays. Device models load from the WebXR input profiles CDN; a local simplified model appears while loading or when offline.

Opening the menu places it about 0.9 m in front of your current head position, upright and facing you. In Free view, the open menu and timeline stay in world space. In Follow camera, the menu travels and turns with the camera while staying upright; turning your head does not move the expanded menu. Returning to Free view places the menu in front of you again. Their size adjusts with viewing distance and grab-move scale to keep a consistent visual size. Point at the small drag bar above the menu icons (or bring a grip within 4 cm), hold grip to move the menu, then release to leave it in place. The panel stays upright. The menu expands into three compact circular icons to the right of **Menu**: camera view, timeline and exit VR. Hover an icon to see its action; active modes have a check marker. While collapsed, the small **Menu** button follows your view so you can reopen the panel in front of you after moving away.

## Controls

| Action | Control |
| --- | --- |
| Select / use menu | Point and press trigger |
| Move an object | Point at it, hold grip, move, then release |
| Grab nearby objects | Bring a controller close: its ray becomes a translucent 12 cm grab sphere; grip the highlighted object to move and rotate it with your hand |
| Move yourself | In free view, grip empty space and pull |
| Rotate / scale the view | Grip empty space with both hands; turn horizontally or spread/pinch |
| Follow a shot | **Follow camera**, then left **Y** to play; **Free view** restores your previous view |
| Scrub timeline | **Timeline**, then move either thumbstick left/right; **Done** exits and keeps the current time |
| Jump to an object's keyframe | Select the object in timeline mode; point at a diamond marker or translucent pose and press trigger |
| Collapse / expand menu | Left **Menu** key, or the **Menu** button; if the device reserves Menu, press the left thumbstick instead |
| Add a keyframe | Select an object, scrub to the desired time, then trigger **+ Keyframe** on the timeline; **Update keyframe** updates the current pose |
| Delete a keyframe | Jump to a selected object key, then trigger **Delete keyframe**; removes all its property keys at that time. Left **X** undoes deletion |
| Move the timeline | Hold grip on its **Grip to move** title bar; release to place |
| Move the menu | Hold grip on the small bar above its icons; release to place |
| Playback | Left **Y** toggles play / pause; its button icon shows the next action; unavailable while editing the timeline |
| Undo | Left **X**, marked with an undo arrow; press once per undo |
| Exit | **Exit VR** in the menu |

Navigation keeps the floor level and never changes project objects. At an existing keyframe, gripping an object updates only the current position and rotation; other keyed poses stay in place. Between keys, animated objects still move with their full motion paths. Pause playback before editing. Tracking loss cancels unfinished object edits and stops navigation.

The left controller shows an **X Undo / Y Play-Pause / Menu Modes** guide and button icons, including the offline model. The guide says **Stick press** when Menu is unavailable. Finish grip gestures before using a shortcut. Disabled icons dim; holding a button never repeats its action. Menu follows the device's input profile: Touch v3 / Touch Plus expose it at index 7 when supported; index 6 is a thumb-rest, not Menu.

Visual feedback uses lime for available targets, amber while gripping or after a successful X/Y action, and cyan brackets for selected objects. Rays have a visible hit marker; the near-grab sphere has three boundary rings. Hovered menu buttons brighten, active modes show a check mark, and hovered timeline keys or ghost poses highlight their jump target.


Timeline mode pauses playback while keeping selection, grip editing, navigation and undo available. At a keyframe, grip edits its position and rotation directly, regardless of Auto Key. Missing channels receive keys to preserve the other keyed poses; scale is unchanged. Adjacent interpolation updates naturally. One grab is one undo step. Scrubbing pauses during an object grab; release the object and center the stick to resume. Center the stick after entering or regaining tracking; push further for faster scrubbing. Use **+ Keyframe** to store the selected object position, rotation and scale at the playhead; an existing key is updated rather than duplicated. Adding a key supports undo. The timeline title bar can be gripped to move the panel while keeping it upright and visually sized like the menu. The timeline is a separate world-space panel: hiding, reopening or dragging the menu does not move or hide it. It remains visible and interactive until **Done** exits timeline mode.

The selected object's property keys are combined by time. Other keyframe poses appear as translucent previews; at the current key, the real editable object replaces its preview. Previews never modify the project and disappear when leaving timeline mode.

Grip targets the real object through translucent previews; trigger still selects previews to jump in time. Timeline mode also allows grip editing of the selected object while following a camera.
