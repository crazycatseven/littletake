import * as THREE from 'three';

export class MenuTexture {
  readonly canvas = document.createElement('canvas');
  readonly texture: THREE.CanvasTexture;
  private image?: HTMLImageElement;
  private source = '';
  private disposed = false;
  constructor(width: number, height: number) {
    this.canvas.width = width; this.canvas.height = height;
    this.texture = new THREE.CanvasTexture(this.canvas); this.texture.colorSpace = THREE.SRGBColorSpace;
  }
  draw(svg: string): void {
    if (this.disposed || svg === this.source) return;
    this.source = svg;
    if (this.image) this.image.onload = null;
    const image = document.createElement('img'); this.image = image;
    image.onload = () => {
      if (this.disposed || this.image !== image) return;
      const ctx = this.canvas.getContext('2d')!;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); ctx.drawImage(image, 0, 0);
      this.texture.needsUpdate = true;
    };
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
  dispose(): void { this.disposed = true; if (this.image) this.image.onload = null; this.texture.dispose(); }
}
