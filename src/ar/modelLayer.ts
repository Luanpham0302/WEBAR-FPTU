import * as THREE from 'three';
import type { LayerRuntime, ModelLayerConfig } from './types';

function disposeMaterial(material: THREE.Material) {
  Object.values(material).forEach((value) => {
    if (value instanceof THREE.Texture) {
      value.dispose();
    }
  });

  material.dispose();
}

function disposeModel(root: THREE.Object3D) {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;

    if (!mesh.isMesh) {
      return;
    }

    mesh.geometry.dispose();

    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material];
    materials.forEach(disposeMaterial);

    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
      (mesh as THREE.SkinnedMesh).skeleton.dispose();
    }
  });
}

export async function createModelLayer(
  config: ModelLayerConfig,
): Promise<LayerRuntime> {
  // Loaded on demand so profiles without 3D never download the loader.
  const { GLTFLoader } = await import(
    'three/examples/jsm/loaders/GLTFLoader.js'
  );
  const gltf = await new GLTFLoader().loadAsync(config.src);
  const model = gltf.scene;

  // Centre the model and normalise its largest dimension to 1, so `scale`
  // means "trigger widths" whatever units the file was authored in.
  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const largestDimension = Math.max(size.x, size.y, size.z) || 1;

  model.position.sub(center);

  const pivot = new THREE.Group();
  pivot.add(model);
  pivot.scale.setScalar(config.scale / largestDimension);
  pivot.rotation.set(
    THREE.MathUtils.degToRad(config.rotation[0]),
    THREE.MathUtils.degToRad(config.rotation[1]),
    THREE.MathUtils.degToRad(config.rotation[2]),
  );
  pivot.position.set(...config.position);

  const mixer =
    gltf.animations.length > 0 ? new THREE.AnimationMixer(model) : null;
  const action = mixer ? mixer.clipAction(gltf.animations[0]) : null;
  let isPlaying = false;

  return {
    object3D: pivot,
    activate() {
      action?.reset().play();
      isPlaying = true;
    },
    resume() {},
    pause() {
      isPlaying = false;
    },
    update(deltaSeconds) {
      if (isPlaying) {
        mixer?.update(deltaSeconds);
      }
    },
    dispose() {
      isPlaying = false;
      mixer?.stopAllAction();
      mixer?.uncacheRoot(model);
      pivot.removeFromParent();
      disposeModel(model);
    },
  };
}
