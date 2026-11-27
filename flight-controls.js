const movementKeys = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE',
  'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight',
]);

export function createFlightControls(THREE, camera, viewport, canvas, extent, render) {
  const keys = new Set();
  const direction = new THREE.Vector3();
  const movement = new THREE.Vector3();
  const pitchLimit = Math.PI / 2 - 0.01;
  const speed = extent / 30;
  const stepSize = speed / 4;
  let enabled = false;
  let yaw = 0;
  let pitch = 0;
  let drag = null;
  let frame = null;
  let lastTime = 0;

  function look() {
    const horizontal = Math.cos(pitch);
    direction.set(horizontal * Math.cos(yaw), horizontal * Math.sin(yaw), Math.sin(pitch));
    camera.lookAt(direction.add(camera.position));
  }

  function move(time) {
    frame = null;
    // Limit the distance travelled during a stalled frame or after switching tabs.
    const elapsed = THREE.MathUtils.clamp((time - lastTime) / 1000, 0, 0.1);
    lastTime = time;
    const right = Number(keys.has('KeyD') || keys.has('ArrowRight'))
      - Number(keys.has('KeyA') || keys.has('ArrowLeft'));
    const forward = Number(keys.has('KeyW') || keys.has('ArrowUp'))
      - Number(keys.has('KeyS') || keys.has('ArrowDown'));
    const up = Number(keys.has('KeyE')) - Number(keys.has('KeyQ'));
    movement.set(right, 0, -forward).applyQuaternion(camera.quaternion);
    movement.z += up;
    if (movement.lengthSq() > 0) {
      const boost = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 4 : 1;
      camera.position.addScaledVector(movement.normalize(), elapsed * speed * boost);
    }
    render();
    if ([...keys].some((key) => movementKeys.has(key))) frame = requestAnimationFrame(move);
  }

  function requestFrame() {
    if (frame !== null) return;
    lastTime = performance.now();
    frame = requestAnimationFrame(move);
  }

  function step(amount) {
    camera.translateZ(-amount * stepSize);
    requestFrame();
  }

  function reset(heading) {
    keys.clear();
    camera.position.set(0, 0, 0);
    yaw = heading ? Math.atan2(heading.y, heading.x) : 0;
    pitch = heading ? THREE.MathUtils.clamp(Math.asin(heading.z), -pitchLimit, pitchLimit) : 0;
    look();
  }

  function endDrag({ pointerId }) {
    if (drag?.pointerId === pointerId) drag = null;
  }

  viewport.addEventListener('keydown', (event) => {
    if (!enabled || event.altKey || event.ctrlKey || event.metaKey) return;
    if (movementKeys.has(event.code)) {
      event.preventDefault();
      keys.add(event.code);
      requestFrame();
    } else if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
      keys.add(event.code);
    }
  });
  viewport.addEventListener('keyup', (event) => keys.delete(event.code));
  viewport.addEventListener('blur', () => keys.clear());
  window.addEventListener('blur', () => keys.clear());
  canvas.addEventListener('pointerdown', (event) => {
    if (!enabled || drag || event.button !== 0) return;
    viewport.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  });
  canvas.addEventListener('pointermove', (event) => {
    if (drag?.pointerId !== event.pointerId) return;
    const radiansPerPixel = THREE.MathUtils.degToRad(camera.fov) / Math.max(1, canvas.clientHeight);
    yaw += (event.clientX - drag.x) * radiansPerPixel;
    pitch = THREE.MathUtils.clamp(pitch + (event.clientY - drag.y) * radiansPerPixel, -pitchLimit, pitchLimit);
    drag.x = event.clientX;
    drag.y = event.clientY;
    look();
    requestFrame();
  });
  canvas.addEventListener('lostpointercapture', endDrag);
  canvas.addEventListener('wheel', (event) => {
    if (!enabled || event.ctrlKey || event.deltaY === 0) return;
    event.preventDefault();
    const unitsPerStep = event.deltaMode === 1 ? 3 : event.deltaMode === 2 ? 1 : 100;
    step(THREE.MathUtils.clamp(-event.deltaY / unitsPerStep, -4, 4));
  }, { passive: false });

  return {
    start(heading) {
      enabled = true;
      reset(heading);
      viewport.focus({ preventScroll: true });
    },
    stop() {
      enabled = false;
      keys.clear();
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      if (drag && canvas.hasPointerCapture(drag.pointerId)) canvas.releasePointerCapture(drag.pointerId);
      drag = null;
    },
    reset,
    step,
  };
}
