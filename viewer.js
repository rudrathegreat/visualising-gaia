const viewport = document.querySelector('#viewport');
const status = document.querySelector('#status');
const catalogCount = document.querySelector('#catalog-count');
const zoomOut = document.querySelector('#zoom-out');
const zoomIn = document.querySelector('#zoom-in');
const reset = document.querySelector('#reset');

async function loadPositions(THREE) {
  const response = await fetch('./stars.bin');
  if (!response.ok) {
    throw new Error('Star data is unavailable. Run python prepare_stars.py and reload.');
  }

  const buffer = await response.arrayBuffer();
  const headerSize = 8;
  if (buffer.byteLength < headerSize) {
    throw new Error('Star data is incomplete. Run python prepare_stars.py again.');
  }

  const header = new DataView(buffer);
  const count = header.getUint32(0, true);
  const skipped = header.getUint32(4, true);
  if (!count || buffer.byteLength !== headerSize + count * 3 * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error('Star data is invalid. Run python prepare_stars.py again.');
  }

  const positions = new Float32Array(buffer, headerSize);
  return { attribute: new THREE.BufferAttribute(positions, 3), count, skipped };
}

async function start() {
  const [THREE, { OrbitControls }] = await Promise.all([
    import('three'),
    import('three/addons/controls/OrbitControls.js'),
  ]).catch(() => {
    throw new Error('Three.js could not load. Run npm install and reload.');
  });

  const { attribute, count, skipped } = await loadPositions(THREE);
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer();
  } catch {
    throw new Error('This viewer requires a browser with WebGL 2 enabled.');
  }
  renderer.setClearColor(0x070c17);
  viewport.append(renderer.domElement);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', attribute);
  geometry.computeBoundingSphere();
  const origin = new THREE.Vector3();
  const { center, radius } = geometry.boundingSphere;
  const extent = Math.max(1, center.length() + radius);

  const stars = new THREE.Points(geometry, new THREE.PointsMaterial({
    color: 0x95bbff,
    size: 1.45,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.25,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }));
  const scene = new THREE.Scene();
  scene.add(stars);

  const camera = new THREE.PerspectiveCamera(50, 1, extent / 50000, extent * 30);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
  controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
  controls.touches.ONE = THREE.TOUCH.PAN;
  controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
  controls.zoomToCursor = true;
  controls.minDistance = extent / 2500;
  controls.maxDistance = extent * 18;
  controls.listenToKeyEvents(viewport);

  const render = () => renderer.render(scene, camera);
  controls.addEventListener('change', render);

  function resize() {
    const { clientWidth: width, clientHeight: height } = viewport;
    if (!width || !height) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    render();
  }

  function resetView() {
    const verticalHalfAngle = THREE.MathUtils.degToRad(camera.fov / 2);
    const horizontalHalfAngle = Math.atan(Math.tan(verticalHalfAngle) * camera.aspect);
    const distance = extent / Math.sin(Math.min(verticalHalfAngle, horizontalHalfAngle));
    camera.position.set(0.30, -0.65, 1).setLength(distance * 1.08);
    controls.target.copy(origin);
    controls.update();
  }

  function zoom(factor) {
    const offset = camera.position.clone().sub(controls.target);
    const distance = THREE.MathUtils.clamp(
      offset.length() * factor, controls.minDistance, controls.maxDistance,
    );
    camera.position.copy(controls.target).add(offset.setLength(distance));
    controls.update();
  }

  zoomIn.addEventListener('click', () => zoom(0.8));
  zoomOut.addEventListener('click', () => zoom(1.25));
  reset.addEventListener('click', resetView);
  new ResizeObserver(resize).observe(viewport);
  resize();
  resetView();

  catalogCount.textContent = `${count.toLocaleString()} stars plotted`
    + (skipped ? ` · ${skipped.toLocaleString()} rows skipped` : '');
  catalogCount.hidden = false;
  status.hidden = true;
  for (const button of [zoomIn, zoomOut, reset]) button.disabled = false;
}

start().catch((error) => {
  status.textContent = error.message;
  console.error(error);
});
