const viewport = document.querySelector('#viewport');
const status = document.querySelector('#status');
const catalogCount = document.querySelector('#catalog-count');
const colorLegend = document.querySelector('#color-legend');
const brightnessLegend = document.querySelector('#brightness-legend');
const zoomOut = document.querySelector('#zoom-out');
const zoomIn = document.querySelector('#zoom-in');
const reset = document.querySelector('#reset');
const sunView = document.querySelector('#sun-view');
const exposure = document.querySelector('#exposure');
const exposureValue = document.querySelector('#exposure-value');

const colorStops = [
  { value: -0.2, color: '#b5cdff' },
  { value: 0.8, color: '#fff8f0' },
  { value: 3.6, color: '#ffa77e' },
];

const orbitReferenceMagnitude = 18;
const sunReferenceMagnitude = 12;

function relativeFlux(magnitude, referenceMagnitude) {
  return 10 ** (0.4 * (referenceMagnitude - magnitude));
}

function showBrightnessLegend(THREE, referenceMagnitude, exposureMultiplier) {
  const sample = new THREE.Color();
  const items = [-6, -3, 0, 3, 6, 9].map((offset) => {
    const magnitude = referenceMagnitude + offset;
    const flux = relativeFlux(magnitude, referenceMagnitude) * exposureMultiplier;
    const brightness = flux / (1 + flux);
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
  const fluxes = new Float32Array(count);
  const [blue, white, orange] = colorStops.map(({ value, color }) => ({
    value,
    rgb: new THREE.Color().setStyle(color, THREE.LinearSRGBColorSpace),
  }));
  const gray = new THREE.Color('#9aa3b2');
  const interpolated = new THREE.Color();
  let hasPhotometry = false;

  for (let i = 0; i < count; i++) {
    const offset = i * valuesPerStar;
    const bpRp = records[offset + 3];
    if (Number.isFinite(bpRp)) {
      const belowMiddle = bpRp < white.value;
      const start = belowMiddle ? blue : white;
      const end = belowMiddle ? white : orange;
      const fraction = THREE.MathUtils.clamp((bpRp - start.value) / (end.value - start.value), 0, 1);
      interpolated.copy(start.rgb).lerp(end.rgb, fraction).convertSRGBToLinear();
    } else {
      interpolated.copy(gray);
    }
    interpolated.toArray(colors, i * 3);
    const magnitude = hasMagnitude ? records[offset + 4] : NaN;
    if (Number.isFinite(magnitude)) {
      hasPhotometry = true;
      fluxes[i] = relativeFlux(THREE.MathUtils.clamp(magnitude, -40, 80), orbitReferenceMagnitude);
    } else {
      fluxes[i] = -1;
    }
  }

  return {
    position,
    color: new THREE.BufferAttribute(colors, 3),
    fluxAtTenParsecs: new THREE.BufferAttribute(fluxes, 1),
    count,
    skipped,
    hasPhotometry,
  };
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

function createStarMaterial(THREE, photometry) {
  const material = new THREE.PointsMaterial({
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
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, photometry);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float fluxAtTenParsecs;
        uniform float fluxScale;
        uniform float missingFlux;
        varying float starBrightness;
      `)
      .replace('#include <project_vertex>', `#include <project_vertex>
        // View-space distance is measured in parsecs from the rendering camera.
        float distanceSquared = max(dot(mvPosition.xyz, mvPosition.xyz), 0.0001);
        float flux = fluxAtTenParsecs < 0.0
          ? missingFlux
          : fluxAtTenParsecs * (100.0 / distanceSquared) * fluxScale;
        starBrightness = flux / (1.0 + flux);
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float starBrightness;')
      .replace('outgoingLight = diffuseColor.rgb;', 'outgoingLight = diffuseColor.rgb * starBrightness;');
  };
  return material;
}

async function start() {
  const [THREE, { OrbitControls }] = await Promise.all([
    import('three'),
    import('three/addons/controls/OrbitControls.js'),
  ]).catch(() => {
    throw new Error('Three.js could not load. Run npm install and reload.');
  });

  const { position, color, fluxAtTenParsecs, count, skipped, hasPhotometry } = await loadCatalog(THREE);
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
  geometry.setAttribute('fluxAtTenParsecs', fluxAtTenParsecs);
  geometry.computeBoundingSphere();
  const origin = new THREE.Vector3();
  const { center, radius } = geometry.boundingSphere;
  const extent = Math.max(1, center.length() + radius);

  const photometry = {
    fluxScale: { value: 1 },
    missingFlux: { value: 0.02 },
  };
  const stars = new THREE.Points(geometry, createStarMaterial(THREE, photometry));
  const scene = new THREE.Scene();
  scene.add(stars);

  const defaultFov = 50;
  const camera = new THREE.PerspectiveCamera(defaultFov, 1, extent / 50000, extent * 30);
  const solarCamera = new THREE.PerspectiveCamera(defaultFov, 1, 0.001, extent * 30);
  camera.up.set(0, 0, 1);
  // OrbitControls handles the gestures on a separate camera so zoom and drag can share one easing curve.
  const navigationCamera = camera.clone();
  const controls = new OrbitControls(navigationCamera, renderer.domElement);
  const viewTarget = new THREE.Vector3();
  const viewOffset = new THREE.Spherical();
  const zUp = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), camera.up);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const orbitPosition = new THREE.Vector3();
  const orbitTarget = new THREE.Vector3();
  let viewFrame = null;
  let lastFrameTime = 0;
  let lastInputTime = 0;
  let fromSun = false;
  controls.listenToKeyEvents(viewport);

  function setNavigation() {
    controls.enablePan = !fromSun;
    controls.mouseButtons.LEFT = fromSun ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
    controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
    controls.touches.ONE = fromSun ? THREE.TOUCH.ROTATE : THREE.TOUCH.PAN;
    controls.touches.TWO = fromSun ? THREE.TOUCH.DOLLY_ROTATE : THREE.TOUCH.DOLLY_PAN;
    controls.zoomToCursor = !fromSun;
    controls.minDistance = fromSun ? 0.35 : extent / 2500;
    controls.maxDistance = fromSun ? 2 : extent * 18;
  }

  function render() {
    if (fromSun) {
      // Apply the eased orientation and field of view from the heliocentric origin.
      solarCamera.quaternion.copy(camera.quaternion);
      const halfAngle = THREE.MathUtils.degToRad(defaultFov / 2);
      solarCamera.fov = THREE.MathUtils.radToDeg(
        2 * Math.atan(Math.tan(halfAngle) * viewOffset.radius),
      );
      solarCamera.updateProjectionMatrix();
    }
    renderer.render(scene, fromSun ? solarCamera : camera);
  }

  function updateExposure() {
    const stops = Number(exposure.value);
    const multiplier = 2 ** stops;
    const referenceMagnitude = fromSun ? sunReferenceMagnitude : orbitReferenceMagnitude;
    photometry.fluxScale.value = multiplier * relativeFlux(orbitReferenceMagnitude, referenceMagnitude);
    photometry.missingFlux.value = multiplier * (hasPhotometry ? 0.02 : 1);
    exposureValue.value = `${stops > 0 ? '+' : ''}${stops} EV`;
    if (hasPhotometry) showBrightnessLegend(THREE, referenceMagnitude, multiplier);
  }

  function snapView() {
    if (viewFrame !== null) cancelAnimationFrame(viewFrame);
    viewFrame = null;
    viewTarget.copy(controls.target);
    viewOffset.set(controls.getDistance(), controls.getPolarAngle(), controls.getAzimuthalAngle());
    camera.position.copy(navigationCamera.position);
    camera.quaternion.copy(navigationCamera.quaternion);
    render();
  }

  function easeView() {
    viewFrame = null;
    const now = performance.now();
    if (reducedMotion.matches || now - lastInputTime >= 360) {
      snapView();
      return;
    }

    const blend = 1 - Math.exp(-(now - lastFrameTime) / 45);
    lastFrameTime = now;
    const azimuthDelta = controls.getAzimuthalAngle() - viewOffset.theta;
    const shortestTurn = THREE.MathUtils.euclideanModulo(azimuthDelta + Math.PI, 2 * Math.PI) - Math.PI;
    viewOffset.theta += shortestTurn * blend;
    viewOffset.phi = THREE.MathUtils.lerp(viewOffset.phi, controls.getPolarAngle(), blend);
    viewOffset.radius = THREE.MathUtils.lerp(viewOffset.radius, controls.getDistance(), blend);
    viewTarget.lerp(controls.target, blend);
    camera.position.setFromSpherical(viewOffset).applyQuaternion(zUp).add(viewTarget);
    camera.lookAt(viewTarget);
    render();
    viewFrame = requestAnimationFrame(easeView);
  }

  controls.addEventListener('change', () => {
    // Pan and cursor zoom read the navigation camera's matrices between input events.
    navigationCamera.updateMatrixWorld();
    if (reducedMotion.matches) {
      snapView();
      return;
    }
    lastInputTime = performance.now();
    if (viewFrame === null) {
      lastFrameTime = lastInputTime;
      viewFrame = requestAnimationFrame(easeView);
    }
  });

  function resize() {
    const { clientWidth: width, clientHeight: height } = viewport;
    if (!width || !height) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    for (const viewCamera of [camera, navigationCamera, solarCamera]) {
      viewCamera.aspect = width / height;
      viewCamera.updateProjectionMatrix();
    }
    render();
  }

  function resetView() {
    if (fromSun) {
      navigationCamera.position.set(-1, 0, 0);
    } else {
      const verticalHalfAngle = THREE.MathUtils.degToRad(camera.fov / 2);
      const horizontalHalfAngle = Math.atan(Math.tan(verticalHalfAngle) * camera.aspect);
      const distance = extent / Math.sin(Math.min(verticalHalfAngle, horizontalHalfAngle));
      navigationCamera.position.set(0.30, -0.65, 1).setLength(distance * 1.08);
    }
    controls.target.copy(origin);
    controls.update();
    snapView();
  }

  function zoom(factor) {
    const offset = navigationCamera.position.clone().sub(controls.target);
    const distance = THREE.MathUtils.clamp(
      offset.length() * factor, controls.minDistance, controls.maxDistance,
    );
    navigationCamera.position.copy(controls.target).add(offset.setLength(distance));
    controls.update();
  }

  zoomIn.addEventListener('click', () => zoom(0.8));
  zoomOut.addEventListener('click', () => zoom(1.25));
  reset.addEventListener('click', resetView);
  exposure.addEventListener('input', () => {
    updateExposure();
    render();
  });
  sunView.addEventListener('click', () => {
    if (!fromSun) {
      orbitPosition.copy(navigationCamera.position);
      orbitTarget.copy(controls.target);
    }
    fromSun = !fromSun;
    sunView.setAttribute('aria-pressed', String(fromSun));
    document.querySelector('#navigation').classList.toggle('from-sun', fromSun);
    setNavigation();
    updateExposure();
    if (fromSun) {
      resetView();
    } else {
      navigationCamera.position.copy(orbitPosition);
      controls.target.copy(orbitTarget);
      controls.update();
      snapView();
    }
  });
  setNavigation();
  updateExposure();
  new ResizeObserver(resize).observe(viewport);
  resize();
  resetView();

  catalogCount.textContent = `${count.toLocaleString()} stars plotted`
    + (skipped ? ` · ${skipped.toLocaleString()} rows skipped` : '');
  catalogCount.hidden = false;
  const [low, middle, high] = colorStops;
  const middlePosition = (middle.value - low.value) / (high.value - low.value) * 100;
  colorLegend.style.setProperty('--middle-position', `${middlePosition}%`);
  colorLegend.querySelector('.color-ramp').style.background =
    `linear-gradient(to right in srgb, ${low.color}, ${middle.color} var(--middle-position), ${high.color})`;
  colorLegend.querySelector('.color-labels').replaceChildren(...colorStops.map(({ value }, i) => {
    const label = document.createElement('span');
    const prefix = ['≤ ', '', '≥ '][i];
    label.textContent = prefix + value.toFixed(1);
    return label;
  }));
  colorLegend.hidden = false;
  status.hidden = true;
  for (const input of [zoomIn, zoomOut, reset, sunView, exposure]) input.disabled = false;
}

start().catch((error) => {
  status.textContent = error.message;
  console.error(error);
});
