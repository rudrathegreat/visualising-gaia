const viewport = document.querySelector('#viewport');
const status = document.querySelector('#status');
const catalogCount = document.querySelector('#catalog-count');
const colorLegend = document.querySelector('#color-legend');
const brightnessLegend = document.querySelector('#brightness-legend');
const zoomOut = document.querySelector('#zoom-out');
const zoomIn = document.querySelector('#zoom-in');
const reset = document.querySelector('#reset');

const colorStops = [
  { value: 0.4, color: '#ff5a55' },
  { value: 0.7, color: '#ffc158' },
  { value: 1.5, color: '#639dff' },
];

function magnitudeBrightness(absoluteMagnitude) {
  if (!Number.isFinite(absoluteMagnitude)) return 0.02;

  // Keep faint stars visible up close without washing out dense regions.
  return 0.002 + 0.998 / (1 + 10 ** ((absoluteMagnitude - 5) / 2.2));
}

function showBrightnessLegend(THREE) {
  const sample = new THREE.Color();
  const items = [-4, 0, 4, 8, 12, 16].map((magnitude) => {
    const brightness = magnitudeBrightness(magnitude);
    const item = document.createElement('li');
    item.textContent = String(magnitude).replace('-', '−');
    item.style.setProperty('--sample-color', sample.setRGB(brightness, brightness, brightness).getStyle());
    return item;
  });
  brightnessLegend.querySelector('.brightness-samples').replaceChildren(...items);
  brightnessLegend.hidden = false;
}

async function loadCatalog(THREE) {
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
  const valuesPerStar = (buffer.byteLength - headerSize) / Float32Array.BYTES_PER_ELEMENT / count;
  // Older catalogs contain only X, Y, Z, and BP–RP.
  if (valuesPerStar !== 4 && valuesPerStar !== 5) {
    throw new Error('Star data is outdated or invalid. Run python prepare_stars.py again.');
  }

  const hasMagnitude = valuesPerStar === 5;
  const records = new Float32Array(buffer, headerSize);
  const data = new THREE.InterleavedBuffer(records, valuesPerStar);
  const position = new THREE.InterleavedBufferAttribute(data, 3, 0);
  const colors = new Float32Array(count * 3);
  const [red, amber, blue] = colorStops.map(({ value, color }) => ({
    value,
    rgb: new THREE.Color().setStyle(color, THREE.LinearSRGBColorSpace),
  }));
  const gray = new THREE.Color('#9aa3b2');
  const interpolated = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const offset = i * valuesPerStar;
    const bpRp = records[offset + 3];
    if (Number.isFinite(bpRp)) {
      const belowMiddle = bpRp < amber.value;
      const start = belowMiddle ? red : amber;
      const end = belowMiddle ? amber : blue;
      const fraction = THREE.MathUtils.clamp((bpRp - start.value) / (end.value - start.value), 0, 1);
      interpolated.copy(start.rgb).lerp(end.rgb, fraction).convertSRGBToLinear();
    } else {
      interpolated.copy(gray);
    }
    const brightness = hasMagnitude ? magnitudeBrightness(records[offset + 4]) : 1;
    interpolated.multiplyScalar(brightness).toArray(colors, i * 3);
  }

  return { position, color: new THREE.BufferAttribute(colors, 3), count, skipped, hasMagnitude };
}

function createStarSprite(THREE) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d');
  const radius = canvas.width / 2;
  const glow = context.createRadialGradient(radius, radius, 0, radius, radius, radius);
  glow.addColorStop(0, 'rgba(255, 255, 255, 1)');
  // Keep the core compact and spread a low-opacity halo around it.
  glow.addColorStop(0.09, 'rgba(255, 255, 255, 0.85)');
  glow.addColorStop(0.2, 'rgba(255, 255, 255, 0.10)');
  glow.addColorStop(0.55, 'rgba(255, 255, 255, 0.045)');
  glow.addColorStop(0.8, 'rgba(255, 255, 255, 0.012)');
  glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
  context.fillStyle = glow;
  context.fillRect(0, 0, canvas.width, canvas.height);
  return new THREE.CanvasTexture(canvas);
}

async function start() {
  const [THREE, { OrbitControls }] = await Promise.all([
    import('three'),
    import('three/addons/controls/OrbitControls.js'),
  ]).catch(() => {
    throw new Error('Three.js could not load. Run npm install and reload.');
  });

  const { position, color, count, skipped, hasMagnitude } = await loadCatalog(THREE);
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer();
  } catch {
    throw new Error('This viewer requires a browser with WebGL 2 enabled.');
  }
  renderer.setClearColor(0x000000);
  viewport.append(renderer.domElement);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', position);
  geometry.setAttribute('color', color);
  geometry.computeBoundingSphere();
  const origin = new THREE.Vector3();
  const { center, radius } = geometry.boundingSphere;
  const extent = Math.max(1, center.length() + radius);

  const stars = new THREE.Points(geometry, new THREE.PointsMaterial({
    map: createStarSprite(THREE),
    vertexColors: true,
    size: 11,
    sizeAttenuation: false,
    transparent: true,
    // Keep the strongest contribution per channel where star sprites overlap.
    premultipliedAlpha: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.MaxEquation,
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
  const [low, middle, high] = colorStops;
  const amberPosition = (middle.value - low.value) / (high.value - low.value) * 100;
  colorLegend.style.setProperty('--amber-position', `${amberPosition}%`);
  colorLegend.querySelector('.color-ramp').style.background =
    `linear-gradient(to right in srgb, ${low.color}, ${middle.color} var(--amber-position), ${high.color})`;
  colorLegend.querySelector('.color-labels').replaceChildren(...colorStops.map(({ value }, i) => {
    const label = document.createElement('span');
    const prefix = ['≤ ', '', '≥ '][i];
    label.textContent = prefix + value.toFixed(1);
    return label;
  }));
  colorLegend.hidden = false;
  if (hasMagnitude) showBrightnessLegend(THREE);
  status.hidden = true;
  for (const button of [zoomIn, zoomOut, reset]) button.disabled = false;
}

start().catch((error) => {
  status.textContent = error.message;
  console.error(error);
});
