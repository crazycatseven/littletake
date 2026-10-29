import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { MenuTexture } from './texture';
import { menuButtonBinding, type XRButtonComponent, type XRMenuBinding } from './buttons';

export function xrControllerIconSvg(action: 'undo' | 'play' | 'menu', playing = false, feedback: 'ready' | 'disabled' | 'pressed' = 'ready'): string {
  const icon = action === 'menu' ? '<path d="M86 100h148M86 160h148M86 220h148" fill="none" stroke="#f6f3e9" stroke-width="24" stroke-linecap="round"/>' : action === 'undo'
    ? '<path d="M114 98 64 148l50 50M70 148h112c82 0 82 100 0 100" fill="none" stroke="#f6f3e9" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/>'
    : playing ? '<path d="M112 86h34v148h-34zM178 86h34v148h-34z" fill="#f6f3e9"/>'
      : '<path d="m116 78 124 82-124 82Z" fill="#f6f3e9"/>';
  const ink = feedback === 'pressed' ? '#10231e' : '#f6f3e9';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320"><circle cx="160" cy="160" r="156" fill="${feedback === 'pressed' ? '#ffbd66' : '#182b26'}"/><circle cx="160" cy="160" r="143" fill="none" stroke="${feedback === 'pressed' ? ink : feedback === 'ready' ? '#c9f86b' : '#789084'}" stroke-width="12"/>${icon.replaceAll('#f6f3e9', ink)}</svg>`;
}

export function xrLeftHintsSvg(fallback: boolean): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240" viewBox="0 0 640 240"><rect x="4" y="4" width="632" height="232" rx="24" fill="#182b26" stroke="#c9f86b" stroke-width="5"/><g font-family="Segoe UI, Arial, sans-serif" fill="#f6f3e9" font-size="38" font-weight="600"><text x="32" y="66">X  Undo</text><text x="300" y="66">Y  Play / Pause</text><text x="32" y="137" fill="#c9f86b">${fallback ? 'Stick press' : 'Menu key'}  ·  Modes</text><text x="32" y="203" font-size="30" fill="#c7d6ce">Trigger: select  ·  Grip: move</text></g></svg>`;
}

type ButtonKey = 'x' | 'y' | 'menu';
interface ButtonHint { mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>; texture: MenuTexture }

/** Controller cosmetics only: excluded from scene selection and document edits. */
export class XRControllerVisual {
  readonly root = new THREE.Group();
  private input = new THREE.Group();
  private fallback = new THREE.Group();
  private resources = new Set<THREE.Object3D>();
  private disposed = false;
  private connected = false;
  private hints = new Map<ButtonKey, ButtonHint>();
  private fallbackX: THREE.Mesh;
  private fallbackY: THREE.Mesh;
  private fallbackMenu: THREE.Mesh;
  private fallbackStick: THREE.Mesh;
  private legend?: ButtonHint;
  private source?: XRInputSource;
  private buttonState: { playing: boolean; canUndo: boolean; canPlay: boolean; canMenu?: boolean } = { playing: false, canUndo: false, canPlay: true };
  private flashes = new Map<ButtonKey, number>();
  private left = false;
  private model: ReturnType<XRControllerModelFactory['createControllerModel']>;

  constructor(grip: THREE.Group, factory?: XRControllerModelFactory) {
    this.root.name = 'XR controller'; this.root.visible = false; grip.add(this.root);
    const shell = new THREE.MeshStandardMaterial({ color: '#354d46', roughness: .65 });
    const accent = new THREE.MeshStandardMaterial({ color: '#d7e9b2', roughness: .7 });
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material, position: THREE.Vector3) => {
      const mesh = new THREE.Mesh(geometry, material); mesh.frustumCulled = false;
      mesh.position.copy(position); this.fallback.add(mesh); return mesh;
    };
    add(new THREE.CapsuleGeometry(.019, .075, 4, 12), shell, new THREE.Vector3(0, -.025, .015)).rotation.x = -.25;
    add(new THREE.SphereGeometry(1, 16, 10), shell, new THREE.Vector3(0, .025, -.01)).scale.set(.033, .018, .042);
    this.fallbackStick = add(new THREE.CylinderGeometry(.007, .007, .012, 12), accent, new THREE.Vector3(0, .046, -.015));
    add(new THREE.BoxGeometry(.022, .012, .014), accent, new THREE.Vector3(0, .014, -.049));
    this.fallbackX = add(new THREE.CylinderGeometry(.006, .006, .006, 16), shell, new THREE.Vector3(.018, .04, .012));
    this.fallbackX.name = 'Fallback X button'; this.fallbackX.visible = false;
    this.fallbackY = add(new THREE.CylinderGeometry(.006, .006, .006, 16), shell, new THREE.Vector3(.018, .04, -.006));
    this.fallbackY.name = 'Fallback Y button'; this.fallbackY.visible = false;
    this.fallbackMenu = add(new THREE.CylinderGeometry(.005, .005, .004, 16), shell, new THREE.Vector3(-.014, .04, .012));
    this.fallbackMenu.name = 'Fallback Menu button'; this.fallbackMenu.visible = false;
    this.fallback.name = 'Offline controller'; this.root.add(this.fallback); this.resources.add(this.fallback);

    if (!factory) {
      const loader = new GLTFLoader(), load = loader.load.bind(loader);
      // The upstream factory throws from its asynchronous model-error callback.
      // Keep the local model on download/parse failure instead.
      loader.load = (url, onLoad, onProgress) => load(url, asset => {
        if (this.disposed) { disposeResources([asset.scene]); return; }
        this.resources.add(asset.scene); onLoad(asset);
      }, onProgress, () => {});
      factory = new XRControllerModelFactory(loader);
    }
    factory.onLoad = scene => {
      if (this.disposed) { disposeResources([scene]); return; }
      // The combined XR frustum can reject close controller parts when the rig
      // is scaled, even though both eye frustums contain them. Let the GPU clip
      // these few tracked meshes per eye; keep their normal depth testing.
      scene.traverse(node => { if (node instanceof THREE.Mesh) node.frustumCulled = false; });
      this.resources.add(scene);
      this.fallback.visible = !this.connected;
      // Attach icons to the profile's actual face buttons, including animated model parts.
      const motion = this.model.motionController as { components?: Record<string, XRButtonComponent> } | null;
      for (const key of ['x', 'y', 'menu'] as const) {
        const component = key === 'menu' ? (this.source && this.menuBinding(this.source)?.fallback ? motion?.components?.['xr-standard-thumbstick'] : motion?.components?.menu ?? motion?.components?.['menu-button']) : motion?.components?.[`${key}-button`];
        const name = component?.rootNodeName;
        const button = name ? scene.getObjectByName(name) : undefined;
        if (button && this.left) this.positionHint(key, button);
      }
      this.setState(this.buttonState);
    };
    // A private event source lets us detach without retaining factory listeners on the real grip.
    this.model = factory.createControllerModel(this.input); this.root.add(this.model);
  }

  private positionHint(key: ButtonKey, button: THREE.Object3D = key === 'x' ? this.fallbackX : key === 'y' ? this.fallbackY : this.source && this.menuBinding(this.source)?.fallback ? this.fallbackStick : this.fallbackMenu): void {
    let hint = this.hints.get(key);
    if (!hint) {
      const texture = new MenuTexture(320, 320);
      // A surface mesh follows the button, unlike a billboard sprite. The XR eye
      // and controller share rig scale, so its apparent size stays fixed during navigation.
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
        map: texture.texture, transparent: true, depthWrite: false, toneMapped: false,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      }));
      mesh.name = key === 'x' ? 'X Undo hint' : key === 'y' ? 'Y Play hint' : 'Menu hint'; mesh.rotation.x = -Math.PI / 2;
      mesh.frustumCulled = false;
      hint = { mesh, texture }; this.hints.set(key, hint); this.setState(this.buttonState);
    }
    const { mesh } = hint;
    mesh.removeFromParent();
    button.updateWorldMatrix(true, true);
    const inverse = button.matrixWorld.clone().invert(), bounds = new THREE.Box3();
    button.traverse(node => {
      if (!(node instanceof THREE.Mesh)) return;
      if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
      if (node.geometry.boundingBox) bounds.union(node.geometry.boundingBox.clone().applyMatrix4(inverse.clone().multiply(node.matrixWorld)));
    });
    const size = bounds.isEmpty() ? new THREE.Vector3(.012, .006, .012) : bounds.getSize(new THREE.Vector3());
    const center = bounds.isEmpty() ? new THREE.Vector3() : bounds.getCenter(new THREE.Vector3());
    const width = Math.max(.006, Math.min(.018, size.x * .9, size.z * .9));
    mesh.scale.set(width, width, 1);
    mesh.position.set(center.x, (bounds.isEmpty() ? .003 : bounds.max.y) + .0002, center.z);
    mesh.visible = this.left; button.add(mesh);
  }

  menuBinding(source: XRInputSource): XRMenuBinding | undefined {
    const motion = this.model.motionController as { components?: Record<string, XRButtonComponent> } | null;
    return menuButtonBinding(source, motion?.components);
  }

  setState(state: { playing: boolean; canUndo: boolean; canPlay: boolean; canMenu?: boolean }): void {
    this.buttonState = state;
    for (const [key, hint] of this.hints) {
      const pressed = (this.flashes.get(key) ?? 0) > performance.now();
      const enabled = key === 'x' ? state.canUndo : key === 'y' ? state.canPlay : state.canMenu !== false;
      hint.texture.draw(xrControllerIconSvg(key === 'x' ? 'undo' : key === 'y' ? 'play' : 'menu', state.playing, pressed ? 'pressed' : enabled ? 'ready' : 'disabled'));
      hint.mesh.material.opacity = pressed || enabled ? 1 : .6;
    }
    if (this.legend && this.source) this.legend.texture.draw(xrLeftHintsSvg(this.menuBinding(this.source)?.fallback !== false));
  }

  acknowledge(action: 'undo' | 'play' | 'menu'): void {
    this.flashes.set(action === 'undo' ? 'x' : action === 'play' ? 'y' : 'menu', performance.now() + 240);
    this.setState(this.buttonState);
  }

  connect(source: XRInputSource): void {
    if (this.disposed) return;
    this.disconnect();
    this.source = source;
    if (source.hand || source.targetRayMode !== 'tracked-pointer' || !source.gripSpace || !source.gamepad) return;
    this.left = source.handedness === 'left'; this.fallbackX.visible = this.left; this.fallbackY.visible = this.left;
    this.fallbackMenu.visible = this.left && this.menuBinding(source)?.fallback === false;
    if (this.left) {
      this.positionHint('x'); this.positionHint('y'); this.positionHint('menu');
      if (!this.legend) {
        const texture = new MenuTexture(640, 240);
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(.14, .0525), new THREE.MeshBasicMaterial({ map: texture.texture, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
        mesh.name = 'Left controls guide'; mesh.position.set(-.09, .055, .005); mesh.rotation.x = -Math.PI / 2; mesh.frustumCulled = false;
        this.root.add(mesh); this.legend = { mesh, texture };
      }
      this.legend.mesh.visible = true; this.setState(this.buttonState);
    }
    this.connected = true; this.root.visible = true; this.fallback.visible = true;
    this.input.dispatchEvent({ type: 'connected', data: source } as never);
  }
  disconnect(): void {
    this.connected = false; this.root.visible = false; this.fallback.visible = true;
    this.left = false;
    if (this.legend) this.legend.mesh.visible = false;
    this.flashes.clear();
    for (const key of this.hints.keys()) this.positionHint(key);
    this.fallbackX.visible = false; this.fallbackY.visible = false; this.fallbackMenu.visible = false;
    this.input.dispatchEvent({ type: 'disconnected' } as never);
    this.source = undefined;
  }
  dispose(): void {
    this.disposed = true; this.disconnect(); this.root.removeFromParent();
    this.hints.forEach(hint => hint.mesh.removeFromParent());
    disposeResources(this.resources); this.resources.clear(); this.root.clear();
    this.hints.forEach(hint => { hint.texture.dispose(); hint.mesh.material.dispose(); hint.mesh.geometry.dispose(); });
    this.hints.clear();
    if (this.legend) { this.legend.texture.dispose(); this.legend.mesh.geometry.dispose(); this.legend.mesh.material.dispose(); this.legend = undefined; }
  }
}

function disposeResources(roots: Iterable<THREE.Object3D>): void {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
  for (const root of roots) root.traverse(node => {
    if (!(node instanceof THREE.Mesh)) return;
    geometries.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  geometries.forEach(value => value.dispose()); materials.forEach(value => value.dispose()); textures.forEach(value => value.dispose());
}
