import { createFlightControls } from './flight-controls.js';

const viewport = document.querySelector('#viewport');
const status = document.querySelector('#status');
const catalogCount = document.querySelector('#catalog-count');
const colorLegend = document.querySelector('#color-legend');
const brightnessLegend = document.querySelector('#brightness-legend');
const zoomOut = document.querySelector('#zoom-out');
const zoomIn = document.querySelector('#zoom-in');
const reset = document.querySelector('#reset');
const sunView = document.querySelector('#sun-view');
const flyView = document.querySelector('#fly-view');
const navigation = document.querySelector('#navigation');
const exposure = document.querySelector('#exposure');
const exposureValue = document.querySelector('#exposure-value');

const colorStops = [
  { value: -0.2, color: '#b5cdff' },
  { value: 0.8, color: '#fff8f0' },
  { value: 3.6, color: '#ffa77e' },
];

const orbitReferenceMagnitude = 18;
const sunReferenceMagnitude = 12;
const starSize = 11;
const catalogMagic = 0x32494147; // GAI2
const catalogHeaderSize = 40;
const chunkHeaderSize = 40;
const bytesPerStar = 20;

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

function invalidCatalog() {
  return new Error('Star data is incomplete or invalid. Run python prepare_stars.py again.');
}

function createCatalogReader(reader) {
  let pending = new Uint8Array();
  let offset = 0;

  async function fill() {
    while (offset === pending.length) {
      const { done, value } = await reader.read();
      if (done) return false;
      pending = value;
      offset = 0;
    }
    return true;
  }

  return {
    async readBytes(length) {
      const bytes = new Uint8Array(length);
      let written = 0;
      while (written < length) {
        if (!(await fill())) throw invalidCatalog();
        const count = Math.min(length - written, pending.length - offset);
        bytes.set(pending.subarray(offset, offset + count), written);
        written += count;
        offset += count;
      }
      return bytes;
    },
    async readLegacy(firstBytes, count) {
      // Older files have either four or five float32 values per star.
      const parts = [firstBytes];
      let length = firstBytes.length;
      const maxLength = firstBytes.length + bytesPerStar * count;
      while (await fill()) {
        const part = pending.subarray(offset);
        length += part.length;
        if (length > maxLength) throw invalidCatalog();
        parts.push(part);
        offset = pending.length;
      }
      return new Blob(parts).arrayBuffer();
    },
    async atEnd() {
      return !(await fill());
    },
  };
}

function makeGeometry(THREE, position, color, flux) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', position);
  geometry.setAttribute('color', color);
  geometry.setAttribute('fluxAtTenParsecs', flux);
  return geometry;
}

function readChunkGeometry(THREE, buffer, count, sphere) {
  const positionsAndFlux = new THREE.InterleavedBuffer(new Float32Array(buffer, 0, count * 4), 4);
  const colors = new THREE.InterleavedBuffer(new Uint8Array(buffer, count * 16, count * 4), 4);
  const geometry = makeGeometry(
    THREE,
    new THREE.InterleavedBufferAttribute(positionsAndFlux, 3, 0),
    new THREE.InterleavedBufferAttribute(colors, 3, 0, true),
    new THREE.InterleavedBufferAttribute(positionsAndFlux, 1, 3),
  );
  geometry.boundingSphere = sphere;
  return geometry;
}

async function* loadCatalog(THREE) {
  const response = await fetch('./stars.bin');
  if (!response.ok) {
    throw new Error('Star data is unavailable. Run python prepare_stars.py and reload.');
  }
  const reader = response.body.getReader();
  const source = createCatalogReader(reader);
  try {
    const firstBytes = await source.readBytes(8);
    const firstHeader = new DataView(firstBytes.buffer);
    const marker = firstHeader.getUint32(0, true);
    if (marker !== catalogMagic) {
      yield readLegacyCatalog(THREE, await source.readLegacy(firstBytes, marker));
      return;
    }

    const count = firstHeader.getUint32(4, true);
    const header = new DataView((await source.readBytes(catalogHeaderSize - firstBytes.length)).buffer);
    const skipped = header.getUint32(0, true);
    const chunkCount = header.getUint32(4, true);
    const previewCount = header.getUint32(8, true);
    const hasPhotometry = Boolean(header.getUint32(12, true) & 1);
    const size = header.getUint32(16, true);
    const extent = header.getFloat64(24, true);
    const expectedSize = catalogHeaderSize + chunkCount * chunkHeaderSize + (previewCount + count) * bytesPerStar;
    if (chunkCount < 1 || chunkCount > count || previewCount < 1 || previewCount > count
      || size !== expectedSize || !Number.isFinite(extent) || extent < 1) {
      throw invalidCatalog();
    }

    const catalog = { count, skipped, extent, hasPhotometry };
    const preview = await source.readBytes(previewCount * bytesPerStar);
    const previewSphere = new THREE.Sphere(new THREE.Vector3(), extent);
    yield {
      ...catalog,
      previewCount,
      chunks: [{
        geometry: readChunkGeometry(THREE, preview.buffer, previewCount, previewSphere),
      }],
    };

    const chunks = [];
    let loaded = 0;
    for (let i = 0; i < chunkCount; i++) {
      const chunk = new DataView((await source.readBytes(chunkHeaderSize)).buffer);
      const length = chunk.getUint32(0, true);
      const x = chunk.getFloat64(8, true);
      const y = chunk.getFloat64(16, true);
      const z = chunk.getFloat64(24, true);
      const radius = chunk.getFloat64(32, true);
      loaded += length;
      if (length < 1 || loaded > count
        || ![x, y, z, radius].every(Number.isFinite) || radius < 0) {
        throw invalidCatalog();
      }
      const data = await source.readBytes(length * bytesPerStar);
      const sphere = new THREE.Sphere(new THREE.Vector3(x, y, z), radius);
      chunks.push({ geometry: readChunkGeometry(THREE, data.buffer, length, sphere) });
    }
    if (loaded !== count || !(await source.atEnd())) throw invalidCatalog();
    yield { ...catalog, chunks };
  } finally {
    // Cancel any unread download after a malformed file or an early exit by the viewer.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function readLegacyCatalog(THREE, buffer) {
  const headerSize = 8;
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

  const geometry = makeGeometry(
    THREE,
    position,
    new THREE.BufferAttribute(colors, 3),
    new THREE.BufferAttribute(fluxes, 1),
  );
  geometry.computeBoundingSphere();
  const { center, radius } = geometry.boundingSphere;
  return {
    chunks: [{ geometry }],
    extent: Math.max(1, center.length() + radius),
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
    size: starSize,
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
      `)
      .replace('gl_PointSize = size;', `// Limit the fill cost of faint stars while retaining bright glows.
        gl_PointSize = size * mix(0.55, 1.0, sqrt(starBrightness));`);
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

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer();
  } catch {
    throw new Error('This viewer requires a browser with WebGL 2 enabled.');
  }
  renderer.setClearColor(0x000000);
  viewport.append(renderer.domElement);

  const catalogs = loadCatalog(THREE);
  const { value: initialCatalog } = await catalogs.next();
  const { count, skipped, extent, hasPhotometry } = initialCatalog;
  const origin = new THREE.Vector3();

  const photometry = {
    fluxScale: { value: 1 },
    missingFlux: { value: 0.02 },
  };
  const material = createStarMaterial(THREE, photometry);
  const scene = new THREE.Scene();
  let chunks = [];
  let viewportWidth = 0;
  let viewportHeight = 0;
  let drawingWidth = 0;
  let drawingHeight = 0;

  function showCatalog(catalog) {
    for (const { geometry } of chunks) geometry.dispose();
    scene.clear();
    chunks = catalog.chunks;
    for (const { geometry } of chunks) scene.add(new THREE.Points(geometry, material));
    catalogCount.textContent = catalog.previewCount
      ? `${catalog.previewCount.toLocaleString()} of ${count.toLocaleString()} stars loaded`
      : `${count.toLocaleString()} stars plotted`
        + (skipped ? ` · ${skipped.toLocaleString()} rows skipped` : '');
    catalogCount.hidden = false;
  }
  showCatalog(initialCatalog);

  const defaultFov = 50;
  const halfFovTangent = Math.tan(THREE.MathUtils.degToRad(defaultFov / 2));
  const camera = new THREE.PerspectiveCamera(defaultFov, 1, extent / 50000, extent * 30);
  const solarCamera = new THREE.PerspectiveCamera(defaultFov, 1, 0.001, extent * 30);
  const flightCamera = solarCamera.clone();
  flightCamera.up.set(0, 0, 1);
  camera.up.set(0, 0, 1);
  // OrbitControls handles the gestures on a separate camera so zoom and drag can share one easing curve.
  const navigationCamera = camera.clone();
  const controls = new OrbitControls(navigationCamera, renderer.domElement);
  const viewTarget = new THREE.Vector3();
  const viewOffset = new THREE.Spherical();
  const zUp = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), camera.up);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const easingTime = 45;
  const settleTime = 8 * easingTime;
  const orbitPosition = new THREE.Vector3();
  const orbitTarget = new THREE.Vector3();
  let viewFrame = null;
  let lastFrameTime = 0;
  let lastInputTime = 0;
  let fromSun = false;
  let flying = false;
  controls.listenToKeyEvents(viewport);

  function setNavigation() {
    controls.enabled = !flying;
    sunView.setAttribute('aria-pressed', String(fromSun && !flying));
    flyView.setAttribute('aria-pressed', String(flying));
    navigation.classList.toggle('from-sun', fromSun && !flying);
    navigation.classList.toggle('flying', flying);
    zoomIn.setAttribute('aria-label', flying ? 'Move forward' : 'Zoom in');
    zoomOut.setAttribute('aria-label', flying ? 'Move backward' : 'Zoom out');
    zoomIn.title = zoomIn.getAttribute('aria-label');
    zoomOut.title = zoomOut.getAttribute('aria-label');
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
    if (viewportWidth === 0 || viewportHeight === 0) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (ratio !== renderer.getPixelRatio() || drawingWidth !== viewportWidth || drawingHeight !== viewportHeight) {
      drawingWidth = viewportWidth;
      drawingHeight = viewportHeight;
      renderer.setDrawingBufferSize(drawingWidth, drawingHeight, ratio);
    }
    if (fromSun && !flying) {
      // Apply the eased orientation and field of view from the heliocentric origin.
      solarCamera.quaternion.copy(camera.quaternion);
      solarCamera.fov = THREE.MathUtils.radToDeg(
        2 * Math.atan(halfFovTangent * viewOffset.radius),
      );
      solarCamera.updateProjectionMatrix();
    }
    renderer.render(scene, flying ? flightCamera : fromSun ? solarCamera : camera);
  }

  function updateExposure() {
    const stops = Number(exposure.value);
    const multiplier = 2 ** stops;
    const referenceMagnitude = fromSun || flying ? sunReferenceMagnitude : orbitReferenceMagnitude;
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
    const radius = controls.getDistance();
    const polar = controls.getPolarAngle();
    const azimuthDelta = controls.getAzimuthalAngle() - viewOffset.theta;
    const shortestTurn = THREE.MathUtils.euclideanModulo(azimuthDelta + Math.PI, 2 * Math.PI) - Math.PI;
    // Stop requesting frames when the remaining camera motion is roughly subpixel.
    const angleTolerance = halfFovTangent * (fromSun ? radius : 1) / Math.max(1, viewportHeight);
    const worldTolerance = radius * angleTolerance;
    const settled = Math.abs(shortestTurn) <= angleTolerance
      && Math.abs(polar - viewOffset.phi) <= angleTolerance
      && Math.abs(radius - viewOffset.radius) <= worldTolerance
      && viewTarget.distanceToSquared(controls.target) <= worldTolerance ** 2;
    if (settled || reducedMotion.matches || now - lastInputTime >= settleTime) {
      snapView();
      return;
    }

    const blend = 1 - Math.exp(-(now - lastFrameTime) / easingTime);
    lastFrameTime = now;
    viewOffset.theta += shortestTurn * blend;
    viewOffset.phi = THREE.MathUtils.lerp(viewOffset.phi, polar, blend);
    viewOffset.radius = THREE.MathUtils.lerp(viewOffset.radius, radius, blend);
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

  function resize(redraw = true) {
    const { clientWidth: width, clientHeight: height } = viewport;
    if (width === viewportWidth && height === viewportHeight) return;
    viewportWidth = width;
    viewportHeight = height;
    if (!viewportWidth || !viewportHeight) return;
    for (const viewCamera of [camera, navigationCamera, solarCamera, flightCamera]) {
      viewCamera.aspect = viewportWidth / viewportHeight;
      viewCamera.updateProjectionMatrix();
    }
    if (redraw) render();
  }

  function resetView() {
    if (flying) {
      flight.reset();
      viewport.focus({ preventScroll: true });
      render();
      return;
    }
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
    if (flying) {
      flight.step(factor < 1 ? 1 : -1);
      return;
    }
    const offset = navigationCamera.position.clone().sub(controls.target);
    const distance = THREE.MathUtils.clamp(
      offset.length() * factor, controls.minDistance, controls.maxDistance,
    );
    navigationCamera.position.copy(controls.target).add(offset.setLength(distance));
    controls.update();
  }

  const flight = createFlightControls(THREE, flightCamera, viewport, renderer.domElement, extent, render);

  function stopFlight() {
    flying = false;
    flight.stop();
    setNavigation();
    updateExposure();
  }

  flyView.addEventListener('click', () => {
    if (flying) {
      stopFlight();
      snapView();
      return;
    }
    if (viewFrame !== null) cancelAnimationFrame(viewFrame);
    viewFrame = null;
    flying = true;
    setNavigation();
    flight.start(fromSun ? solarCamera.getWorldDirection(new THREE.Vector3()) : undefined);
    updateExposure();
    render();
  });
  zoomIn.addEventListener('click', () => zoom(0.8));
  zoomOut.addEventListener('click', () => zoom(1.25));
  reset.addEventListener('click', resetView);
  exposure.addEventListener('input', () => {
    updateExposure();
    render();
  });
  sunView.addEventListener('click', () => {
    if (flying) {
      stopFlight();
      if (fromSun) {
        snapView();
        return;
      }
    }
    if (!fromSun) {
      orbitPosition.copy(navigationCamera.position);
      orbitTarget.copy(controls.target);
    }
    fromSun = !fromSun;
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
  new ResizeObserver(() => resize()).observe(viewport);
  resize(false);
  resetView();

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
  for (const input of [zoomIn, zoomOut, reset, sunView, flyView, exposure]) input.disabled = false;
  for await (const catalog of catalogs) {
    showCatalog(catalog);
    render();
  }
}

start().catch((error) => {
  status.hidden = false;
  status.textContent = error.message;
  console.error(error);
});
