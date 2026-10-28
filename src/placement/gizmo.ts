import { Mesh, MeshBasicMaterial, Object3D, Vector3 } from 'three';

type Handles = Object3D & { isTransformControlsGizmo?: boolean; gizmo: Record<string, Object3D>; picker: Record<string, Object3D> };

/** Remove negative move arrows and their hit areas; retain normal single-object scale handles. */
export function configureHandles(helper: Object3D): (uniform: boolean) => void {
  const handles = helper.children.find(child => (child as Handles).isTransformControlsGizmo) as Handles | undefined;
  if (!handles) return () => {};
  for (const group of [handles.gizmo.translate, handles.picker.translate]) {
    for (const handle of [...group.children]) {
      const axis = 'XYZ'.indexOf(handle.name);
      if (!(handle instanceof Mesh) || handle.name.length !== 1 || axis < 0) continue;
      handle.geometry.computeBoundingBox();
      if (handle.geometry.boundingBox!.getCenter(new Vector3()).getComponent(axis) < -.001) {
        group.remove(handle); handle.geometry.dispose();
      }
    }
  }
  const scale = [handles.gizmo.scale, handles.picker.scale].map(group => ({ group, children: [...group.children].filter(child => child.name !== 'XYZ') }));
  const center = handles.gizmo.scale.children.find(child => child.name === 'XYZ');
  if (center instanceof Mesh) {
    center.geometry.scale(1.7, 1.7, 1.7);
    center.material = new MeshBasicMaterial({ color: '#81945d', depthTest: false, depthWrite: false, transparent: true, opacity: .95, toneMapped: false });
  }
  return uniform => {
    for (const { group, children } of scale) for (const child of children) {
      if (uniform) group.remove(child);
      else if (child.parent !== group) group.add(child);
    }
  };
}
