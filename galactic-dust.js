export const galacticCenter = [8200, 0, 0];
export const dustRadius = 15000;

// The thin disk combines broad spiral arms with smaller, irregular clouds.
function makeDustTexture(THREE) {
  const size = 512;
  const pixels = new Uint8Array(size * size);

  function hash(x, y) {
    let value = Math.imul(x, 374761393) + Math.imul(y, 668265263) + 1013904223;
    value = Math.imul(value ^ (value >>> 13), 1274126177);
    return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
  }

  function noise(x, y, scale) {
    const px = x / scale;
    const py = y / scale;
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    const fx = px - ix;
    const fy = py - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const mix = THREE.MathUtils.lerp;
    return mix(mix(hash(ix, iy), hash(ix + 1, iy), sx),
      mix(hash(ix, iy + 1), hash(ix + 1, iy + 1), sx), sy);
  }

  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const x = ((column + 0.5) / size * 2 - 1) * dustRadius;
      const y = ((row + 0.5) / size * 2 - 1) * dustRadius;
      const r = Math.hypot(x, y);
      const clouds = noise(x, y, 850) * 0.5 + noise(x, y, 330) * 0.32 + noise(x, y, 140) * 0.18;
      const azimuth = Math.atan2(y, x);
      const angle = azimuth - Math.log(Math.max(r, 1300) / 8200) / 0.29;
      const distortion = 0.55 * Math.sin(2 * azimuth + r / 2200) + 3.1 * (noise(x, y, 1900) - 0.5);
      const arm = 0.5 + 0.5 * Math.cos(4 * angle + distortion);
      const armStrength = THREE.MathUtils.smoothstep(r, 1100, 3000);
      const mainArms = 0.6 + 0.4 * Math.cos(2 * angle - 0.55);
      const density = (0.28 + 2.0 * clouds * clouds)
        * (0.68 + 2.5 * arm ** 5 * armStrength * mainArms);
      pixels[row * size + column] = Math.round(255 * Math.min(density / 4, 1));
    }
  }

  const texture = new THREE.DataTexture(pixels, size, size, THREE.RedFormat);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export const dustShader = /* glsl */ `
  uniform vec3 galacticCenter;
  uniform sampler2D dustDensity;
  const float dustRadius = ${dustRadius.toFixed(1)};
  const float dustHalfHeight = 1350.0;
  const vec3 extinctionRGB = vec3(0.79, 1.0, 1.29);

  // Return the part of a ray inside the finite dust volume, in parsecs.
  vec2 dustInterval(vec3 origin, vec3 direction, float limit) {
    vec2 interval = vec2(0.0, limit);
    if (abs(direction.z) > 1e-7) {
      vec2 heights = (vec2(-dustHalfHeight, dustHalfHeight) - origin.z) / direction.z;
      interval = vec2(max(interval.x, min(heights.x, heights.y)),
        min(interval.y, max(heights.x, heights.y)));
    } else if (abs(origin.z) >= dustHalfHeight) {
      return vec2(0.0);
    }

    float a = dot(direction.xy, direction.xy);
    if (a < 1e-14) {
      return dot(origin.xy, origin.xy) < dustRadius * dustRadius ? interval : vec2(0.0);
    }
    float closest = -dot(origin.xy, direction.xy) / a;
    vec2 offset = origin.xy + closest * direction.xy;
    float remaining = dustRadius * dustRadius - dot(offset, offset);
    if (remaining <= 0.0) return vec2(0.0);
    float halfChord = sqrt(remaining / a);
    return vec2(max(interval.x, closest - halfChord), min(interval.y, closest + halfChord));
  }

  float verticalIntegral(float z0, float z1, float scale, float width) {
    float heightChange = abs(z1 - z0);
    if (heightChange < 0.002 * scale) return width * exp(-abs(0.5 * (z0 + z1)) / scale);
    vec2 density = exp(-abs(vec2(z0, z1)) / scale);
    float integral = z0 * z1 < 0.0 ? 2.0 - density.x - density.y : abs(density.x - density.y);
    return width * scale * integral / heightChange;
  }

  float dustStep(vec3 origin, vec3 direction, float start, float end) {
    vec3 middle = origin + direction * (0.5 * (start + end));
    float r = length(middle.xy);
    float radial = exp((8200.0 - max(r, 900.0)) / 5000.0)
      * (1.0 - smoothstep(13000.0, dustRadius, r));
    float thin = 4.0 * texture2D(dustDensity, 0.5 + middle.xy / (2.0 * dustRadius)).r;
    float z0 = origin.z + direction.z * start;
    float z1 = origin.z + direction.z * end;
    float width = end - start;
    return radial * (0.00077 * thin * verticalIntegral(z0, z1, 73.0, width)
      + 0.00015 * verticalIntegral(z0, z1, 225.0, width));
  }

  float stellarDustDepth(vec3 observer, vec3 star) {
    vec3 offset = star - observer;
    float lengthToStar = length(offset);
    if (lengthToStar < 0.001) return 0.0;
    vec3 origin = observer - galacticCenter;
    vec3 direction = offset / lengthToStar;
    vec2 interval = dustInterval(origin, direction, lengthToStar);
    if (interval.y <= interval.x) return 0.0;
    float width = (interval.y - interval.x) * 0.25;
    float depth = 0.0;
    for (int i = 0; i < 4; i++) {
      float start = interval.x + width * float(i);
      depth += dustStep(origin, direction, start, start + width);
    }
    return depth;
  }
`;

const screenVertex = /* glsl */ `
  varying vec2 screenUV;
  void main() {
    screenUV = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export function createDustRenderer(THREE, renderer) {
  const dustUniforms = {
    galacticCenter: { value: new THREE.Vector3(...galacticCenter) },
    dustDensity: { value: makeDustTexture(THREE) },
  };
  const starTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
  const hazeTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
  const screenCamera = new THREE.Camera();
  const geometry = new THREE.PlaneGeometry(2, 2);
  const screenScene = new THREE.Scene();

  const haze = new THREE.ShaderMaterial({
    uniforms: {
      ...dustUniforms,
      inverseProjection: { value: new THREE.Matrix4() },
      cameraWorld: { value: new THREE.Matrix4() },
    },
    vertexShader: screenVertex,
    fragmentShader: /* glsl */ `
      varying vec2 screenUV;
      uniform mat4 inverseProjection;
      uniform mat4 cameraWorld;
      ${dustShader}

      void main() {
        vec3 ray = (inverseProjection * vec4(2.0 * screenUV - 1.0, 0.0, 1.0)).xyz;
        vec3 direction = normalize(mat3(cameraWorld) * ray);
        vec3 origin = cameraWorld[3].xyz - galacticCenter;
        vec2 interval = dustInterval(origin, direction, 1e8);
        vec3 light = vec3(0.0);
        if (interval.y > interval.x) {
          vec3 transmission = vec3(1.0);
          float start = interval.x;
          for (int i = 1; i <= 40; i++) {
            // Spend more samples on nearby structures for observers inside the disk.
            float t = float(i) / 40.0;
            float end = mix(interval.x, interval.y, t * (0.35 + 0.65 * t));
            vec3 middle = origin + direction * (0.5 * (start + end));
            float r = length(middle.xy);
            float column = dustStep(origin, direction, start, end);
            vec3 stepTransmission = exp(-column * extinctionRGB);

            // Approximate illumination by the Galactic stellar disk as a smooth field.
            float illumination = 0.13 + 1.2 * exp(-r / 4800.0);
            float cosine = dot(middle.xy, -direction.xy) / max(r, 10.0);
            float g = 0.55;
            float phase = (1.0 - g * g) * pow(max(1.0 + g * g - 2.0 * g * cosine, 0.15), -1.5);
            vec3 source = vec3(0.19, 0.146, 0.106) * illumination * (0.65 + 0.35 * phase);
            light += transmission * (1.0 - stepTransmission) * 0.58 * source;
            transmission *= stepTransmission;
            if (transmission.r < 0.003) break;
            start = end;
          }
        }
        gl_FragColor = sRGBTransferOETF(vec4(light, 1.0));
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
  const composite = new THREE.ShaderMaterial({
    uniforms: {
      stars: { value: starTarget.texture },
      haze: { value: hazeTarget.texture },
    },
    vertexShader: screenVertex,
    fragmentShader: /* glsl */ `
      varying vec2 screenUV;
      uniform sampler2D stars;
      uniform sampler2D haze;
      void main() {
        vec3 direct = sRGBTransferEOTF(texture2D(stars, screenUV)).rgb;
        vec3 scattered = sRGBTransferEOTF(texture2D(haze, screenUV)).rgb;
        gl_FragColor = vec4(direct + scattered, 1.0);
        #include <colorspace_fragment>
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
  const screen = new THREE.Mesh(geometry, haze);
  screen.frustumCulled = false;
  screenScene.add(screen);
  let hazeReady = false;

  return {
    dustUniforms,
    resize(width, height) {
      starTarget.setSize(width, height);
      hazeTarget.setSize(Math.max(1, Math.ceil(width / 2)), Math.max(1, Math.ceil(height / 2)));
      hazeReady = false;
    },
    render(scene, camera) {
      renderer.setRenderTarget(starTarget);
      renderer.render(scene, camera);
      const projection = haze.uniforms.inverseProjection.value;
      const world = haze.uniforms.cameraWorld.value;
      if (!hazeReady || !projection.equals(camera.projectionMatrixInverse) || !world.equals(camera.matrixWorld)) {
        projection.copy(camera.projectionMatrixInverse);
        world.copy(camera.matrixWorld);
        screen.material = haze;
        renderer.setRenderTarget(hazeTarget);
        renderer.render(screenScene, screenCamera);
        hazeReady = true;
      }
      screen.material = composite;
      renderer.setRenderTarget(null);
      renderer.render(screenScene, screenCamera);
    },
  };
}
