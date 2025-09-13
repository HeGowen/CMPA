// renderer/js/gaze3d.js
// [NEW] three.js 可视化：屏幕矩形+人脸点云+视线+屏幕落点；正视视角

export class Gaze3DView {
  constructor(container, opts = {}) {
    this.cont = container;
    this.mmW = opts.mmW || 344;
    this.mmH = opts.mmH || 194;
    this.mmOffset = opts.mmOffset || 0;

    this._initThree();
  }

  _initThree() {
    const width = this.cont.clientWidth || 760;
    const height = this.cont.clientHeight || 320;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(width, height);
    this.cont.innerHTML = '';
    this.cont.appendChild(this.renderer.domElement);

    // 正交相机直视屏幕
    this.camera = new THREE.OrthographicCamera(
      -this.mmW/2 - 50, this.mmW/2 + 50,   // left/right
       this.mmH + this.mmOffset + 50, this.mmOffset - 50,  // top/bottom
      -50, 1000
    );
    // 让 camera 看向 z=0 面
    this.camera.position.set(0, this.mmH/2, 500);
    this.camera.lookAt(0, this.mmH/2, 0);

    this.scene = new THREE.Scene();

    // 屏幕矩形 (z=0)
    const g = new THREE.BufferGeometry();
    const verts = new Float32Array([
      -this.mmW/2, this.mmOffset, 0,
       this.mmW/2, this.mmOffset, 0,

       this.mmW/2, this.mmOffset, 0,
       this.mmW/2, this.mmH + this.mmOffset, 0,

       this.mmW/2, this.mmH + this.mmOffset, 0,
      -this.mmW/2, this.mmH + this.mmOffset, 0,

      -this.mmW/2, this.mmH + this.mmOffset, 0,
      -this.mmW/2, this.mmOffset, 0,
    ]);
    g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    this.screen = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xff0000, linewidth: 2 }));
    this.scene.add(this.screen);

    // 人脸点云
    this.faceGeo = new THREE.BufferGeometry();
    this.faceMat = new THREE.PointsMaterial({ color: 0x7f7f7f, size: 2 });
    this.facePoints = new THREE.Points(this.faceGeo, this.faceMat);
    this.scene.add(this.facePoints);

    // 视线
    this.gazeGeo = new THREE.BufferGeometry();
    this.gazeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.gazeLine = new THREE.Line(this.gazeGeo, new THREE.LineBasicMaterial({ color: 0x00aa44, linewidth: 2 }));
    this.scene.add(this.gazeLine);

    // 落点
    const c = new THREE.SphereGeometry(3, 16, 16);
    this.dot = new THREE.Mesh(c, new THREE.MeshBasicMaterial({ color: 0x9467bd }));
    this.dot.visible = false;
    this.scene.add(this.dot);

    // 文本：用 DOM 覆盖，避免三方字体
    this.label = document.createElement('div');
    this.label.style.cssText = 'font:12px Consolas,monospace; text-align:center; margin-top:4px;';
    this.cont.appendChild(this.label);

    this._animate();
  }

  _animate() {
    this._raf = requestAnimationFrame(()=>this._animate());
    this.renderer.render(this.scene, this.camera);
  }

  /** 更新可视化：face3d: 3xN, center: [x,y,z], gaze_v: [x,y,z], inter3d: [x,y,0] 或 null */
  update(face3d, center, gaze_v, inter3d) {
    // face points
    if (face3d && face3d[0] && face3d[0].length) {
      const N = face3d[0].length;
      const arr = new Float32Array(N * 3);
      for (let i=0;i<N;i++){
        arr[i*3+0] = face3d[0][i];
        arr[i*3+1] = face3d[1][i];
        arr[i*3+2] = face3d[2][i];
      }
      this.faceGeo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      this.faceGeo.attributes.position.needsUpdate = true;
      this.facePoints.visible = true;
    } else {
      this.facePoints.visible = false;
    }

    // gaze segment
    if (center && gaze_v) {
      const c = center; const v = gaze_v;
      const L = 800;
      const end = [ c[0] + v[0]*L, c[1] + v[1]*L, c[2] + v[2]*L ];
      const data = new Float32Array([ c[0], c[1], c[2],  end[0], end[1], end[2] ]);
      this.gazeGeo.setAttribute('position', new THREE.BufferAttribute(data, 3));
      this.gazeGeo.attributes.position.needsUpdate = true;
      this.gazeLine.visible = true;

      this.label.textContent = `Center(mm): (${c[0]|0}, ${c[1]|0}, ${c[2]|0})`;
    } else {
      this.gazeLine.visible = false;
      this.label.textContent = '';
    }

    // hit point
    if (inter3d && Number.isFinite(inter3d[0])) {
      this.dot.position.set(inter3d[0], inter3d[1], inter3d[2] || 0);
      this.dot.visible = true;
    } else {
      this.dot.visible = false;
    }
  }

  resize() {
    const width = this.cont.clientWidth || 760;
    const height = this.cont.clientHeight || 320;
    this.renderer.setSize(width, height);
  }

  setMonitor(mmW, mmH, offset=0) {
    this.mmW = mmW; this.mmH = mmH; this.mmOffset = offset;
    // 简化处理：不重建矩形，实际使用中可重建 geometry 以反映变化
  }
}
